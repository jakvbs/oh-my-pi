import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
	ModelRegistry,
	type SessionAgentDefinition,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { shutdownAll as shutdownLspClients } from "../../../src/lsp/client";
import {
	authorizeContextToolCall,
	CONTEXT_TOOL_NAMES,
	type ContextToolMode,
	MAX_CONTEXT_TOOL_CALLS,
	MAX_PLANNER_CONTEXT_TOOL_CALLS,
	PLANNER_TOOL_NAMES,
} from "./context-tools";
import plannerPrompt from "./prompts/planner.md" with { type: "text" };
import judgeProtocol from "./prompts/protocol.md" with { type: "text" };
import { judgeDefinitions, judgeDefinitionsById } from "./prompts/registry";
import routerPrompt from "./prompts/router.md" with { type: "text" };
import scoutPrompt from "./prompts/scout.md" with { type: "text" };
import type { JudgeDefinition, JudgeType } from "./prompts/types";
import { buildSemanticSourceCatalog } from "./semantic-chunks";
import {
	buildDeterministicSourceIndex,
	type DeterministicSourceIndex,
	HARD_MAX_UNIT_TOKENS,
	type LoadLspSymbols,
	PREFERRED_MAX_UNIT_TOKENS,
	type SemanticUnit,
	type SemanticUnitPlan,
	semanticUnitPlanSchema,
	TARGET_UNIT_TOKENS,
	validateSemanticUnitPlan,
} from "./semantic-units";
import { countTextTokens } from "./token-count";

const MAX_SOURCE_CHARACTERS = 200_000;
const MAX_TOTAL_SOURCE_CHARACTERS = 500_000;
const MAX_REQUEST_TOKENS = 150_000;
const PROMPT_VERSION = "model-routed-code-review/2.0.0";
const OUTPUT_SCHEMA_VERSION = "judge-output/4.0.0";
const CONTEXT_TOOL_POLICY_VERSION = "read-only-context/2.0.0";
const THINKING_LEVEL = ThinkingLevel.Medium;
const JUDGE_CONCURRENCY = 10;

const verdictSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE", "INSUFFICIENT_CONTEXT", "CONFLICTING_EVIDENCE"]);
const severitySchema = z.enum(["heuristic", "minor", "major", "critical"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

const judgeGroupIds = new Set(judgeDefinitions.map(group => group.id));

const routerOutputSchema = z
	.object({
		selectedReviews: z
			.array(
				z
					.object({
						unit_id: z.string().min(1),
						judge_id: z.string().refine(id => judgeGroupIds.has(id), "Unknown judge group"),
						reason: z.string().min(1),
					})
					.strict(),
			)
			.min(1),
	})
	.strict();

const semanticUnitScout = {
	name: "scout",
	description: "Builds complete vertical semantic units from a deterministic AST/LSP source index",
	tools: ["read", "ast_grep"],
	model: ["@smol"],
	thinkingLevel: ThinkingLevel.Medium,
	readSummarize: false,
	systemPrompt: scoutPrompt,
	output: z.toJSONSchema(semanticUnitPlanSchema),
} satisfies SessionAgentDefinition;

const evidenceSchema = z
	.object({
		source_id: z.string().min(1),
		start_line: z.number().int().positive(),
		end_line: z.number().int().positive(),
		quote: z.string().min(1),
		observation: z.string().min(1),
		supports: z.string().min(1),
	})
	.strict();

const criterionResultSchema = z
	.object({
		criterion_id: z.string().min(1),
		verdict: verdictSchema,
		severity: severitySchema,
		confidence: confidenceSchema,
		evidence: z.array(evidenceSchema),
		missing_evidence: z.array(z.string().min(1)),
		reason: z.string().min(1),
		suggested_action: z.string().nullable(),
		verification_after_change: z.string().nullable(),
	})
	.strict();

const judgeOutputSchema = z
	.object({
		criterion_results: z.array(criterionResultSchema).min(1).max(10),
	})
	.strict();

type Source = {
	id: string;
	path: string;
	content: string;
};

type LineRange = { startLine: number; endLine: number };
type SourceView = { source: Source; ranges: LineRange[] };

type RoutedReview = JudgeDefinition & {
	unit: SemanticUnit;
	selectedFragmentIds: string[];
	routeReason: string;
};

type CriterionResult = z.infer<typeof criterionResultSchema>;
type JudgeOutput = z.infer<typeof judgeOutputSchema>;
type Evidence = z.infer<typeof evidenceSchema>;
type VerifiedEvidence = Evidence & { hash: string };
type VerifiedCriterionResult = Omit<CriterionResult, "evidence"> & { evidence: VerifiedEvidence[] };
type VerifiedJudgeOutput = Omit<JudgeOutput, "criterion_results"> & {
	criterion_results: VerifiedCriterionResult[];
};
type Judgment = {
	groupId: string;
	unitId: string;
	judgeType: JudgeType;
	output: VerifiedJudgeOutput;
	execution: PromptExecutionMetadata;
};

type JudgeFailure = {
	groupId: string;
	unitId: string;
	judgeType: JudgeType;
	error: string;
	execution?: PromptExecutionMetadata;
};

type EvidenceIssue = {
	criterionId: string;
	evidenceIndex: number;
	sourceId: string;
	error: string;
};

type EvidenceFailure = EvidenceIssue & {
	unitId: string;
	groupId: string;
	judgeType: JudgeType;
};

type GroupResult =
	| {
			unitId: string;
			groupId: string;
			judgeType: JudgeType;
			rubricVersion: string;
			selectedFragmentIds: string[];
			status: "succeeded";
			judgment: Judgment;
	  }
	| {
			unitId: string;
			groupId: string;
			judgeType: JudgeType;
			rubricVersion: string;
			selectedFragmentIds: string[];
			status: "failed";
			failure: JudgeFailure;
			evidenceFailures: EvidenceFailure[];
	  };

class EvidenceValidationError extends Error {
	execution?: PromptExecutionMetadata;

	constructor(readonly issues: EvidenceIssue[]) {
		super(issues.map(issue => `${issue.criterionId}[${issue.evidenceIndex}]: ${issue.error}`).join("; "));
		this.name = "EvidenceValidationError";
	}
}

type TokenUsage = {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

type PromptExecutionMetadata = {
	durationMs: number;
	tokenUsage: TokenUsage;
	contextTools: {
		enabled: boolean;
		maxCalls: number;
		requestedCalls: number;
		blockedCalls: number;
		callsByTool: Record<string, number>;
	};
};

type PromptResult<Output> = {
	output: Output;
	execution: PromptExecutionMetadata;
	contextSources?: Source[];
};

class PromptExecutionError extends Error {
	constructor(
		message: string,
		readonly execution: PromptExecutionMetadata,
		cause: unknown,
	) {
		super(message, { cause });
		this.name = "PromptExecutionError";
	}
}

export type PromptRunner = <Output>(request: {
	resultSchema: z.ZodType<Output>;
	systemPrompt: string;
	userPrompt: string;
	contextTools?: { mode: ContextToolMode; roots: string[] };
}) => Promise<PromptResult<Output>>;

const yieldResultEnvelopeSchema = z
	.object({
		status: z.string(),
		error: z.unknown().optional(),
		schemaOverridden: z.unknown().optional(),
		data: z.unknown(),
	})
	.passthrough();
const incrementalYieldSchema = z.object({ type: z.array(z.unknown()).min(1) }).passthrough();
const readResultDetailsSchema = z.object({ resolvedPath: z.string() }).passthrough();

export function validateTerminalYieldResult<Output>({
	details,
	incrementalYieldCount,
	resultSchema,
	terminalYieldCount,
}: {
	details: unknown;
	incrementalYieldCount: number;
	resultSchema: z.ZodType<Output>;
	terminalYieldCount: number;
}): Output {
	if (incrementalYieldCount !== 0) {
		throw new Error(`SDK session produced ${incrementalYieldCount} non-terminal yields`);
	}
	if (terminalYieldCount !== 1) {
		throw new Error(`SDK session produced ${terminalYieldCount} terminal yields`);
	}
	const result = yieldResultEnvelopeSchema.parse(details);
	if (result.status !== "success") {
		throw new Error(`SDK session aborted: ${String(result.error ?? "unknown error")}`);
	}
	const schemaOverridden = result.schemaOverridden ?? false;
	if (schemaOverridden !== false) {
		throw new Error("SDK session exhausted yield schema retries");
	}
	const [output] = z.array(resultSchema).length(1).parse(result.data);
	return resultSchema.parse(output);
}

function isIncrementalYield(details: unknown) {
	return incrementalYieldSchema.safeParse(details).success;
}

async function createSdkPromptRunner() {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const model = modelRegistry.find("openai-codex", "gpt-5.6-luna");
	if (!model) {
		throw new Error("Model openai-codex/gpt-5.6-luna is unavailable or not authenticated");
	}

	const runPrompt: PromptRunner = async ({ contextTools, resultSchema, systemPrompt, userPrompt }) => {
		const startedAt = performance.now();
		const terminalSchema = z.array(resultSchema).length(1);
		const mode = contextTools?.mode ?? "none";
		const enabled = mode !== "none";
		const plannerEnabled = mode === "semantic_planning";
		const audit: PromptExecutionMetadata["contextTools"] = {
			enabled,
			maxCalls: plannerEnabled ? MAX_PLANNER_CONTEXT_TOOL_CALLS + 1 : enabled ? MAX_CONTEXT_TOOL_CALLS : 0,
			requestedCalls: 0,
			blockedCalls: 0,
			callsByTool: {},
		};
		const contextReadPaths = new Set<string>();
		const cwd = process.cwd();
		const roots = [cwd, ...(contextTools?.roots ?? [])];
		const contextToolGuard: ExtensionFactory = api => {
			api.on("tool_call", async event => {
				if (event.toolName === "yield") return undefined;
				audit.requestedCalls++;
				audit.callsByTool[event.toolName] = (audit.callsByTool[event.toolName] ?? 0) + 1;
				const reason = authorizeContextToolCall({
					callCount: audit.requestedCalls,
					cwd,
					input: event.input,
					mode,
					roots,
					taskCallCount: audit.callsByTool.task ?? 0,
					toolName: event.toolName,
				});
				if (!reason) return undefined;
				audit.blockedCalls++;
				return { block: true, reason };
			});
		};
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.enableLsp": false,
			"task.maxConcurrency": 1,
			"task.maxRecursionDepth": 1,
		});
		const { session } = await createAgentSession({
			agentDefinitions: plannerEnabled ? [semanticUnitScout] : [],
			authStorage,
			contextFiles: [],
			cwd,
			customTools: [],
			disableExtensionDiscovery: true,
			enableLsp: enabled,
			enableMCP: false,
			extensions: [contextToolGuard],
			model,
			modelRegistry,
			outputSchema: z.toJSONSchema(terminalSchema),
			preloadedCustomToolPaths: [],
			requireYieldTool: true,
			sessionManager: SessionManager.inMemory(),
			settings,
			skills: [],
			slashCommands: [],
			spawns: plannerEnabled ? "scout" : "",
			systemPrompt: [systemPrompt],
			thinkingLevel: THINKING_LEVEL,
			toolNames: plannerEnabled ? [...PLANNER_TOOL_NAMES] : enabled ? [...CONTEXT_TOOL_NAMES] : [],
		});

		let terminalYieldDetails: unknown;
		let terminalYieldCount = 0;
		let incrementalYieldCount = 0;
		let successfulScoutCalls = 0;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_execution_end" || event.isError) return;
			if (event.toolName === "task") {
				successfulScoutCalls++;
				return;
			}
			if (event.toolName === "read") {
				const details = readResultDetailsSchema.safeParse(event.result.details);
				if (details.success) contextReadPaths.add(details.data.resolvedPath);
				return;
			}
			if (event.toolName !== "yield") return;
			if (isIncrementalYield(event.result.details)) {
				incrementalYieldCount++;
			} else {
				terminalYieldCount++;
				terminalYieldDetails = event.result.details;
			}
		});
		const executionMetadata = (): PromptExecutionMetadata => {
			const tokenUsage: TokenUsage = {
				input: 0,
				output: 0,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			};
			for (const message of session.state.messages) {
				if (message.role !== "assistant") continue;
				tokenUsage.input += message.usage.input;
				tokenUsage.output += message.usage.output;
				tokenUsage.reasoning += message.usage.reasoningTokens ?? 0;
				tokenUsage.cacheRead += message.usage.cacheRead;
				tokenUsage.cacheWrite += message.usage.cacheWrite;
				tokenUsage.totalTokens += message.usage.totalTokens;
			}
			return { contextTools: audit, durationMs: Math.round(performance.now() - startedAt), tokenUsage };
		};

		try {
			await session.prompt(userPrompt);
			if (plannerEnabled && successfulScoutCalls !== 1) {
				throw new Error(`Semantic planner completed with ${successfulScoutCalls} successful scout calls`);
			}
			const output = validateTerminalYieldResult({
				details: terminalYieldDetails,
				incrementalYieldCount,
				resultSchema,
				terminalYieldCount,
			});
			return {
				output,
				execution: executionMetadata(),
				contextSources: await readContextSources(contextReadPaths),
			};
		} catch (error) {
			throw new PromptExecutionError(
				error instanceof Error ? error.message : String(error),
				executionMetadata(),
				error,
			);
		} finally {
			unsubscribe();
			await session.dispose();
		}
	};

	return { modelId: `${model.provider}/${model.id}`, runPrompt };
}

async function readContextSources(paths: Iterable<string>): Promise<Source[]> {
	const sources = await Promise.all(
		[...paths].map(async path => {
			try {
				return { id: path, path, content: await readFile(path, "utf8") };
			} catch {
				return null;
			}
		}),
	);
	return sources.filter((source): source is Source => source !== null);
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--") args.shift();
	const [reviewGoal, ...filePaths] = args;
	if (!reviewGoal || filePaths.length === 0) {
		throw new Error(
			'Usage: bun examples/sdk/14-model-routed-code-review/index.ts "<review goal>" <artifact-file> [additional-source ...]',
		);
	}

	const { modelId, runPrompt } = await createSdkPromptRunner();
	try {
		const result = await runReview({
			filePaths,
			modelId,
			reviewGoal,
			riskLevel: riskLevelSchema.parse(process.env.RISK_LEVEL ?? "medium"),
			runPrompt,
		});
		console.log(JSON.stringify(result, null, 2));
	} finally {
		await shutdownLspClients();
	}
}

export async function runReview({
	filePaths,
	loadLspSymbols,
	modelId,
	reviewGoal,
	riskLevel,
	runPrompt,
}: {
	filePaths: string[];
	loadLspSymbols?: LoadLspSymbols;
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	runPrompt: PromptRunner;
}) {
	const startedAt = new Date();
	const startedAtMs = performance.now();
	const sources = await readSources(filePaths);
	const semanticCatalog = await buildSemanticSourceCatalog(sources);
	const sourceIndex = loadLspSymbols
		? await buildDeterministicSourceIndex(sources, semanticCatalog, loadLspSymbols)
		: await buildDeterministicSourceIndex(sources, semanticCatalog);
	const inputFingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				reviewGoal,
				riskLevel,
				sourceIndexHash: sourceIndex.hash,
				sources: sources.map(source => ({ id: source.id, content: source.content })),
			}),
		)
		.digest("hex");
	const { plan: semanticPlan, execution: plannerExecution } = await planSemanticUnits({
		reviewGoal,
		runPrompt,
		sourceIndex,
	});
	const { selectedReviews, execution: routerExecution } = await routeReview({
		reviewGoal,
		runPrompt,
		semanticPlan,
	});
	const settledJudgments = await mapSettledWithConcurrency(selectedReviews, JUDGE_CONCURRENCY, review =>
		runJudge({
			group: review,
			reviewGoal,
			riskLevel,
			runPrompt,
			sources,
			sourceViews: selectSourceViews(review.unit, sources, sourceIndex),
		}),
	);
	const groupResults: GroupResult[] = settledJudgments.map((result, index) => {
		const review = selectedReviews[index];
		if (!review) throw new Error("Judge result order is inconsistent");
		if (result.status === "fulfilled") {
			return {
				unitId: review.unit.id,
				rubricVersion: review.rubricVersion,
				groupId: review.id,
				judgeType: review.judgeType,
				selectedFragmentIds: review.selectedFragmentIds,
				status: "succeeded",
				judgment: result.value,
			};
		}

		const failure = {
			unitId: review.unit.id,
			groupId: review.id,
			...(result.reason instanceof PromptExecutionError || result.reason instanceof EvidenceValidationError
				? { execution: result.reason.execution }
				: {}),
			judgeType: review.judgeType,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
		};
		const evidenceFailures =
			result.reason instanceof EvidenceValidationError
				? result.reason.issues.map(issue => ({
						unitId: review.unit.id,
						groupId: review.id,
						judgeType: review.judgeType,
						...issue,
					}))
				: [];
		return {
			unitId: review.unit.id,
			rubricVersion: review.rubricVersion,
			groupId: review.id,
			judgeType: review.judgeType,
			selectedFragmentIds: review.selectedFragmentIds,
			status: "failed",
			failure,
			evidenceFailures,
		};
	});
	const judgments = groupResults.flatMap(result => (result.status === "succeeded" ? [result.judgment] : []));
	const failures = groupResults.flatMap(result => (result.status === "failed" ? [result.failure] : []));
	const executions = [
		plannerExecution,
		routerExecution,
		...groupResults.flatMap(result => {
			if (result.status === "succeeded") return [result.judgment.execution];
			return result.failure.execution ? [result.failure.execution] : [];
		}),
	];
	const tokenUsage = sumTokenUsage(executions.map(execution => execution.tokenUsage));
	const evidenceFailures = groupResults.flatMap(result => (result.status === "failed" ? result.evidenceFailures : []));

	return {
		semanticUnits: semanticPlan.units,
		selectedReviews: selectedReviews.map(review => ({ unitId: review.unit.id, judgeId: review.id })),
		groupResults,
		failures,
		evidenceFailures,
		incomplete: failures.length > 0,
		execution: {
			startedAt: startedAt.toISOString(),
			durationMs: Math.round(performance.now() - startedAtMs),
			modelId,
			thinkingLevel: THINKING_LEVEL,
			promptVersion: PROMPT_VERSION,
			outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
			rubricVersions: Object.fromEntries(
				selectedReviews.map(review => [`${review.unit.id}:${review.id}`, review.rubricVersion]),
			),
			inputFingerprint,
			tokenUsage,
			contextTools: aggregateContextToolUsage(executions),
			planner: plannerExecution,
			router: routerExecution,
			semanticContext: {
				sourceIndexHash: sourceIndex.hash,
				sourceCount: sourceIndex.sources.length,
				fragmentCount: sourceIndex.fragmentsById.size,
				unitCount: semanticPlan.units.length,
				maximumUnitTokens: Math.max(...semanticPlan.units.map(unit => unit.estimatedTokens)),
				uniqueEvidenceTokens: semanticPlan.uniqueEvidenceTokens,
				plannedEvidenceTokens: semanticPlan.plannedEvidenceTokens,
				fanOutRatio: semanticPlan.plannedEvidenceTokens / semanticPlan.uniqueEvidenceTokens,
			},
		},
		aggregate: aggregateJudgments(judgments, failures.length, groupResults.length),
	};
}
async function readSources(filePaths: string[]): Promise<Source[]> {
	const sources = await Promise.all(
		filePaths.map(async (filePath, index) => {
			const absolutePath = resolve(filePath);
			const content = (await readFile(absolutePath, "utf8")).replace(/\r\n?/g, "\n");
			if (content.length > MAX_SOURCE_CHARACTERS) {
				throw new Error(`${absolutePath} exceeds the per-source context limit`);
			}

			return {
				id: `source-${index + 1}:${basename(absolutePath)}`,
				path: absolutePath,
				content,
			};
		}),
	);

	const totalCharacters = sources.reduce((total, source) => total + source.content.length, 0);
	if (totalCharacters > MAX_TOTAL_SOURCE_CHARACTERS) {
		throw new Error("Sources exceed the total context limit");
	}

	return sources;
}

async function planSemanticUnits({
	reviewGoal,
	runPrompt,
	sourceIndex,
}: {
	reviewGoal: string;
	runPrompt: PromptRunner;
	sourceIndex: DeterministicSourceIndex;
}): Promise<{ plan: SemanticUnitPlan; execution: PromptExecutionMetadata }> {
	const request = {
		reviewGoal,
		budgets: {
			targetUnitTokens: TARGET_UNIT_TOKENS,
			preferredMaxUnitTokens: PREFERRED_MAX_UNIT_TOKENS,
			hardMaxUnitTokens: HARD_MAX_UNIT_TOKENS,
			maxSupportingRatio: 0.3,
		},
		sourceIndex: {
			version: sourceIndex.version,
			hash: sourceIndex.hash,
			totalEstimatedTokens: sourceIndex.totalEstimatedTokens,
			sources: sourceIndex.sources,
		},
	};
	if (countTextTokens(`${plannerPrompt}\n${JSON.stringify(request)}`) > MAX_REQUEST_TOKENS) {
		throw new Error("Semantic planner request exceeds the context limit");
	}
	const { output, execution } = await runPrompt({
		resultSchema: semanticUnitPlanSchema,
		systemPrompt: plannerPrompt,
		userPrompt: JSON.stringify(request),
		contextTools: {
			mode: "semantic_planning",
			roots: [...new Set(sourceIndex.sources.map(source => dirname(source.path)))],
		},
	});
	return { plan: validateSemanticUnitPlan(output, sourceIndex), execution };
}

async function routeReview({
	reviewGoal,
	runPrompt,
	semanticPlan,
}: {
	reviewGoal: string;
	runPrompt: PromptRunner;
	semanticPlan: SemanticUnitPlan;
}): Promise<{ selectedReviews: RoutedReview[]; execution: PromptExecutionMetadata }> {
	const { output, execution } = await runPrompt({
		resultSchema: routerOutputSchema,
		systemPrompt: routerPrompt,
		userPrompt: JSON.stringify({ reviewGoal, semanticUnits: semanticPlan.units }),
	});

	const unitsById = new Map(semanticPlan.units.map(unit => [unit.id, unit]));
	const seenReviews = new Set<string>();
	const routedUnitIds = new Set<string>();
	const selectedReviews = output.selectedReviews.map(selection => {
		const unit = unitsById.get(selection.unit_id);
		if (!unit) throw new Error(`Router selected an unknown semantic unit: ${selection.unit_id}`);
		const group = judgeDefinitionsById.get(selection.judge_id);
		if (!group) throw new Error(`Router selected an unknown judge group: ${selection.judge_id}`);
		const reviewId = `${unit.id}:${group.id}`;
		if (seenReviews.has(reviewId)) throw new Error(`Router selected duplicate review: ${reviewId}`);
		seenReviews.add(reviewId);
		routedUnitIds.add(unit.id);
		return {
			...group,
			unit,
			selectedFragmentIds: [...unit.primary_fragment_ids, ...unit.supporting_fragment_ids],
			routeReason: selection.reason,
		};
	});
	for (const unit of semanticPlan.units) {
		if (!routedUnitIds.has(unit.id)) throw new Error(`Router selected no judge for semantic unit: ${unit.id}`);
	}
	return { selectedReviews, execution };
}

function selectSourceViews(unit: SemanticUnit, sources: Source[], index: DeterministicSourceIndex): SourceView[] {
	const rangesBySource = new Map<string, LineRange[]>();
	const indexedSources = new Map(index.sources.map(source => [source.id, source]));
	const addRange = (sourceId: string, range: LineRange) => {
		const ranges = rangesBySource.get(sourceId) ?? [];
		ranges.push(range);
		rangesBySource.set(sourceId, ranges);
	};

	for (const fragmentId of [...unit.primary_fragment_ids, ...unit.supporting_fragment_ids]) {
		const fragment = index.fragmentsById.get(fragmentId);
		if (!fragment) throw new Error(`Selected fragment disappeared: ${fragmentId}`);
		const source = indexedSources.get(fragment.sourceId);
		if (source?.preambleEndLine) addRange(fragment.sourceId, { startLine: 1, endLine: source.preambleEndLine });
		if (fragment.contextRange) addRange(fragment.sourceId, fragment.contextRange);
		addRange(fragment.sourceId, { startLine: fragment.startLine, endLine: fragment.endLine });
	}

	const orderedSources = [...sources].sort(
		(left, right) => Number(right.id === unit.owner_source_id) - Number(left.id === unit.owner_source_id),
	);
	return orderedSources.flatMap(source => {
		const ranges = rangesBySource.get(source.id);
		return ranges ? [{ source, ranges: mergeLineRanges(ranges) }] : [];
	});
}

function mergeLineRanges(ranges: LineRange[]) {
	const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

async function runJudge({
	group,
	reviewGoal,
	riskLevel,
	runPrompt,
	sources,
	sourceViews,
}: {
	group: RoutedReview;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	runPrompt: PromptRunner;
	sources: Source[];
	sourceViews: SourceView[];
}): Promise<Judgment> {
	const system = `${judgeProtocol}\n\n${group.prompt}`;
	const request = buildJudgeRequest({
		group,
		reviewGoal,
		riskLevel,
		sourceViews,
		system,
	});

	const {
		output,
		execution,
		contextSources = [],
	} = await runPrompt({
		resultSchema: judgeOutputSchema,
		systemPrompt: system,
		userPrompt: JSON.stringify(request),
		contextTools: { mode: "read_only", roots: [...new Set(sources.map(source => dirname(source.path)))] },
	});

	try {
		validateJudgeOutput(group, output);
		return {
			groupId: group.id,
			unitId: group.unit.id,
			judgeType: group.judgeType,
			output: verifyEvidence(output, [...sources, ...contextSources]),
			execution,
		};
	} catch (error) {
		if (error instanceof EvidenceValidationError) error.execution = execution;
		throw error;
	}
}

function buildJudgeRequest({
	group,
	reviewGoal,
	riskLevel,
	sourceViews,
	system,
}: {
	group: RoutedReview;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	sourceViews: SourceView[];
	system: string;
}) {
	const serializedSources = sourceViews.map(serializeSourceForJudge);
	const artifact = serializedSources[0];
	if (!artifact) throw new Error("A primary artifact is required");

	const request = {
		review_goal: reviewGoal,
		selected_group: group.id,
		risk_level: riskLevel,
		artifact,
		rubric: group.criterionIds,
		allowed_sources: serializedSources.slice(1),
		semantic_unit: {
			id: group.unit.id,
			behavior: group.unit.behavior,
			owner_source_id: group.unit.owner_source_id,
			rationale: group.unit.rationale,
			primary_fragment_ids: group.unit.primary_fragment_ids,
			supporting_fragment_ids: group.unit.supporting_fragment_ids,
		},
		reference_data: [],
		deterministic_evidence: [],
		context_tools: {
			policy_version: CONTEXT_TOOL_POLICY_VERSION,
			allowed_tools: [...CONTEXT_TOOL_NAMES],
			max_calls: MAX_CONTEXT_TOOL_CALLS,
			evidence_source_id: "exact local path returned by read",
		},
	};

	if (countTextTokens(`${system}\n${JSON.stringify(request)}`) > MAX_REQUEST_TOKENS) {
		throw new Error(`Judge request for ${group.id} exceeds the context limit`);
	}

	return request;
}

function serializeSourceForJudge(view: SourceView) {
	const lines = view.source.content.split("\n");
	return {
		id: view.source.id,
		content: {
			ranges: view.ranges.map(range => ({
				start_line: range.startLine,
				end_line: range.endLine,
				lines: lines
					.slice(range.startLine - 1, range.endLine)
					.map((text, index) => ({ number: range.startLine + index, text })),
			})),
		},
		locations: "inclusive original-source line ranges",
	};
}

function validateJudgeOutput(group: JudgeDefinition, output: JudgeOutput) {
	const expectedIds = new Set(group.criterionIds);
	const actualIds = new Set(output.criterion_results.map(result => result.criterion_id));
	if (
		actualIds.size !== output.criterion_results.length ||
		actualIds.size !== expectedIds.size ||
		[...expectedIds].some(id => !actualIds.has(id))
	) {
		throw new Error(`Judge ${group.id} did not return every criterion exactly once`);
	}
}

function verifyEvidence(output: JudgeOutput, sources: Source[]): VerifiedJudgeOutput {
	const sourcesById = new Map(sources.map(source => [source.id, source]));
	const issues: EvidenceIssue[] = [];
	const criterionResults: VerifiedCriterionResult[] = [];

	for (const result of output.criterion_results) {
		const verifiedEvidence: VerifiedEvidence[] = [];
		for (let evidenceIndex = 0; evidenceIndex < result.evidence.length; evidenceIndex++) {
			const evidence = result.evidence[evidenceIndex]!;
			const issue = (error: string) => {
				issues.push({
					criterionId: result.criterion_id,
					evidenceIndex,
					sourceId: evidence.source_id,
					error,
				});
			};
			const source = sourcesById.get(evidence.source_id);
			if (!source) {
				issue(`unknown source_id ${evidence.source_id}`);
				continue;
			}
			const lines = source.content.split("\n");
			if (evidence.end_line < evidence.start_line) {
				issue(`end_line ${evidence.end_line} precedes start_line ${evidence.start_line}`);
				continue;
			}
			if (evidence.end_line > lines.length) {
				issue(`line range ${evidence.start_line}-${evidence.end_line} exceeds ${lines.length} lines`);
				continue;
			}
			const quotedRange = lines.slice(evidence.start_line - 1, evidence.end_line).join("\n");
			if (evidence.quote.replace(/\r\n?/g, "\n") !== quotedRange) {
				issue(`quote does not match lines ${evidence.start_line}-${evidence.end_line}`);
				continue;
			}
			verifiedEvidence.push({
				...evidence,
				quote: quotedRange,
				hash: createHash("sha256").update(quotedRange).digest("hex"),
			});
		}
		criterionResults.push({ ...result, evidence: verifiedEvidence });
	}

	if (issues.length > 0) throw new EvidenceValidationError(issues);
	return { ...output, criterion_results: criterionResults };
}

function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
	return usages.reduce<TokenUsage>(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			reasoning: total.reasoning + usage.reasoning,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			totalTokens: total.totalTokens + usage.totalTokens,
		}),
		{ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	);
}

function aggregateContextToolUsage(executions: PromptExecutionMetadata[]) {
	const callsByTool: Record<string, number> = {};
	let requestedCalls = 0;
	let blockedCalls = 0;
	for (const execution of executions) {
		requestedCalls += execution.contextTools.requestedCalls;
		blockedCalls += execution.contextTools.blockedCalls;
		for (const [toolName, calls] of Object.entries(execution.contextTools.callsByTool)) {
			callsByTool[toolName] = (callsByTool[toolName] ?? 0) + calls;
		}
	}
	return { policyVersion: CONTEXT_TOOL_POLICY_VERSION, requestedCalls, blockedCalls, callsByTool };
}

function aggregateJudgments(judgments: Judgment[], failureCount: number, selectedGroupCount: number) {
	const results = judgments.flatMap(judgment => judgment.output.criterion_results);

	let overallVerdict: "PASS" | "FAIL" | "NEEDS_REVIEW" | "INSUFFICIENT_CONTEXT";
	if (results.some(result => isSeverity(result, "critical", "major") && result.verdict === "FAIL")) {
		overallVerdict = "FAIL";
	} else if (failureCount > 0) {
		overallVerdict = "INSUFFICIENT_CONTEXT";
	} else if (
		results.some(result => isSeverity(result, "critical", "major") && result.verdict === "INSUFFICIENT_CONTEXT")
	) {
		overallVerdict = "INSUFFICIENT_CONTEXT";
	} else if (results.some(requiresReview)) {
		overallVerdict = "NEEDS_REVIEW";
	} else {
		overallVerdict = "PASS";
	}

	return {
		overallVerdict,
		failureCount,
		incomplete: failureCount > 0,
		selectedGroupCount,
		completedGroupCount: judgments.length,
		criterionCount: results.length,
		counts: Object.fromEntries(
			verdictSchema.options.map(verdict => [verdict, results.filter(result => result.verdict === verdict).length]),
		),
	};
}

function isSeverity(result: CriterionResult, ...severities: Array<CriterionResult["severity"]>) {
	return severities.includes(result.severity);
}

function requiresReview(result: CriterionResult) {
	return (
		result.verdict === "CONFLICTING_EVIDENCE" ||
		result.verdict === "INSUFFICIENT_CONTEXT" ||
		result.verdict === "FAIL" ||
		(isSeverity(result, "major", "critical") && result.confidence === "low")
	);
}

async function mapSettledWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error("Concurrency must be a positive integer");
	}
	const results = new Array<PromiseSettledResult<R>>(items.length);
	let nextIndex = 0;
	const runWorker = async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			const item = items[index]!;
			try {
				results[index] = { status: "fulfilled", value: await worker(item, index) };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
	return results;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await main();
}

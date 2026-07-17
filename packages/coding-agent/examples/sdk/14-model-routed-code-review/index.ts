import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { judgeProtocol } from "./prompts/protocol";
import { judgeDefinitions, judgeDefinitionsById } from "./prompts/registry";
import { routerPrompt } from "./prompts/router";
import type { JudgeDefinition, JudgeType } from "./prompts/types";
import { buildSemanticSourceCatalog, type SemanticSourceCatalog, type SourceCatalogEntry } from "./semantic-chunks";
import { countTextTokens } from "./token-count";

const MAX_SOURCE_CHARACTERS = 200_000;
const MAX_TOTAL_SOURCE_CHARACTERS = 500_000;
const MAX_REQUEST_TOKENS = 150_000;
const PROMPT_VERSION = "model-routed-code-review/1.2.0";
const OUTPUT_SCHEMA_VERSION = "judge-output/2.0.0";
const CONTEXT_LIMITS_VERSION = "example-context-limits/2.1.0";
const DECISION_POLICY_VERSION = "analysis-only/1.0.0";
const THINKING_LEVEL = ThinkingLevel.Low;
const JUDGE_CONCURRENCY = 10;

const verdictSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE", "INSUFFICIENT_CONTEXT", "CONFLICTING_EVIDENCE"]);
const severitySchema = z.enum(["heuristic", "minor", "major", "critical"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

const judgeGroupIds = new Set(judgeDefinitions.map(group => group.id));

const routerOutputSchema = z
	.object({
		selectedGroups: z
			.array(
				z
					.object({
						id: z.string().refine(id => judgeGroupIds.has(id), "Unknown judge group"),
						reason: z.string().min(1),
						source_ids: z.array(z.string().min(1)),
						chunk_ids: z.array(z.string().min(1)),
					})
					.strict(),
			)
			.min(1)
			.max(judgeDefinitions.length),
	})
	.strict();

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
		evaluation_id: z.string().min(1),
		prompt_version: z.string().min(1),
		rubric_version: z.string().min(1),
		model_id: z.string().min(1),
		output_schema_version: z.string().min(1),
		criterion_results: z.array(criterionResultSchema).min(1).max(10),
		overall_verdict: z.enum(["PASS", "FAIL", "NEEDS_REVIEW", "INSUFFICIENT_CONTEXT"]),
		automation_decision: z.literal("ANALYSIS_ONLY"),
		escalation_required: z.boolean(),
		escalation_reasons: z.array(z.string().min(1)),
	})
	.strict();

type Source = {
	id: string;
	path: string;
	content: string;
};

type LineRange = { startLine: number; endLine: number };
type SourceView = { source: Source; ranges: LineRange[] };

type RoutedJudgeGroup = JudgeDefinition & {
	selectedSourceIds: string[];
	selectedChunkIds: string[];
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
	judgeType: JudgeType;
	output: VerifiedJudgeOutput;
	execution: PromptExecutionMetadata;
};

type JudgeFailure = {
	groupId: string;
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
	groupId: string;
	judgeType: JudgeType;
};

type GroupResult =
	| {
			groupId: string;
			judgeType: JudgeType;
			rubricVersion: string;
			selectedSourceIds: string[];
			selectedChunkIds: string[];
			status: "succeeded";
			judgment: Judgment;
	  }
	| {
			groupId: string;
			judgeType: JudgeType;
			rubricVersion: string;
			selectedSourceIds: string[];
			selectedChunkIds: string[];
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
};

type PromptResult<Output> = {
	output: Output;
	execution: PromptExecutionMetadata;
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
}) => Promise<PromptResult<Output>>;

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
	if (!details || typeof details !== "object") {
		throw new Error("SDK session completed without yielding a result");
	}
	const result = details as Record<string, unknown>;
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
	if (!details || typeof details !== "object") return false;
	return Array.isArray((details as Record<string, unknown>).type);
}

async function createSdkPromptRunner() {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const model = modelRegistry.find("openai-codex", "gpt-5.6-luna");
	if (!model) {
		throw new Error("Model openai-codex/gpt-5.6-luna is unavailable or not authenticated");
	}

	const runPrompt: PromptRunner = async ({ resultSchema, systemPrompt, userPrompt }) => {
		const startedAt = performance.now();
		const terminalSchema = z.array(resultSchema).length(1);
		const { session } = await createAgentSession({
			authStorage,
			contextFiles: [],
			customTools: [],
			disableExtensionDiscovery: true,
			enableLsp: false,
			enableMCP: false,
			extensions: [],
			model,
			modelRegistry,
			outputSchema: z.toJSONSchema(terminalSchema),
			preloadedCustomToolPaths: [],
			requireYieldTool: true,
			sessionManager: SessionManager.inMemory(),
			skills: [],
			slashCommands: [],
			systemPrompt: [systemPrompt],
			thinkingLevel: THINKING_LEVEL,
			toolNames: [],
		});

		let terminalYieldDetails: unknown;
		let terminalYieldCount = 0;
		let incrementalYieldCount = 0;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_execution_end" || event.toolName !== "yield" || event.isError) return;
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
			return { durationMs: Math.round(performance.now() - startedAt), tokenUsage };
		};

		try {
			await session.prompt(userPrompt);
			const output = validateTerminalYieldResult({
				details: terminalYieldDetails,
				incrementalYieldCount,
				resultSchema,
				terminalYieldCount,
			});
			return { output, execution: executionMetadata() };
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
	const result = await runReview({
		filePaths,
		modelId,
		reviewGoal,
		riskLevel: riskLevelSchema.parse(process.env.RISK_LEVEL ?? "medium"),
		runPrompt,
	});

	console.log(JSON.stringify(result, null, 2));
}

export async function runReview({
	filePaths,
	modelId,
	reviewGoal,
	riskLevel,
	runPrompt,
}: {
	filePaths: string[];
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	runPrompt: PromptRunner;
}) {
	const startedAt = new Date();
	const startedAtMs = performance.now();
	const sources = await readSources(filePaths);
	const semanticCatalog = await buildSemanticSourceCatalog(sources);
	const inputFingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				reviewGoal,
				riskLevel,
				sources: sources.map(source => ({ id: source.id, content: source.content })),
			}),
		)
		.digest("hex");
	const { selectedGroups, execution: routerExecution } = await routeReview({
		reviewGoal,
		runPrompt,
		sourceCatalog: semanticCatalog.sources,
	});
	const settledJudgments = await mapSettledWithConcurrency(selectedGroups, JUDGE_CONCURRENCY, group =>
		runJudge({
			group,
			modelId,
			reviewGoal,
			riskLevel,
			runPrompt,
			sources,
			sourceViews: selectSourceViews(group, sources, semanticCatalog),
		}),
	);
	const groupResults: GroupResult[] = settledJudgments.map((result, index) => {
		const group = selectedGroups[index];
		if (!group) throw new Error("Judge result order is inconsistent");
		if (result.status === "fulfilled") {
			return {
				rubricVersion: group.rubricVersion,
				groupId: group.id,
				judgeType: group.judgeType,
				selectedSourceIds: group.selectedSourceIds,
				selectedChunkIds: group.selectedChunkIds,
				status: "succeeded",
				judgment: result.value,
			};
		}

		const failure = {
			groupId: group.id,
			...(result.reason instanceof PromptExecutionError || result.reason instanceof EvidenceValidationError
				? { execution: result.reason.execution }
				: {}),
			judgeType: group.judgeType,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
		};
		const evidenceFailures =
			result.reason instanceof EvidenceValidationError
				? result.reason.issues.map(issue => ({
						groupId: group.id,
						judgeType: group.judgeType,
						...issue,
					}))
				: [];
		return {
			rubricVersion: group.rubricVersion,
			groupId: group.id,
			judgeType: group.judgeType,
			selectedSourceIds: group.selectedSourceIds,
			selectedChunkIds: group.selectedChunkIds,
			status: "failed",
			failure,
			evidenceFailures,
		};
	});
	const judgments = groupResults.flatMap(result => (result.status === "succeeded" ? [result.judgment] : []));
	const failures = groupResults.flatMap(result => (result.status === "failed" ? [result.failure] : []));
	const executions = [
		routerExecution,
		...groupResults.flatMap(result => {
			if (result.status === "succeeded") return [result.judgment.execution];
			return result.failure.execution ? [result.failure.execution] : [];
		}),
	];
	const tokenUsage = sumTokenUsage(executions.map(execution => execution.tokenUsage));

	const evidenceFailures = groupResults.flatMap(result => (result.status === "failed" ? result.evidenceFailures : []));

	return {
		selectedGroups: selectedGroups.map(group => group.id),
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
			rubricVersions: Object.fromEntries(selectedGroups.map(group => [group.id, group.rubricVersion])),
			inputFingerprint,
			tokenUsage,
			router: routerExecution,
			semanticContext: {
				chunkedSourceCount: semanticCatalog.sources.filter(source => source.chunked).length,
				availableChunkCount: semanticCatalog.chunksById.size,
				selectedSourceCount: new Set(selectedGroups.flatMap(group => group.selectedSourceIds)).size,
				selectedChunkCount: new Set(selectedGroups.flatMap(group => group.selectedChunkIds)).size,
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

async function routeReview({
	reviewGoal,
	runPrompt,
	sourceCatalog,
}: {
	reviewGoal: string;
	runPrompt: PromptRunner;
	sourceCatalog: SourceCatalogEntry[];
}): Promise<{ selectedGroups: RoutedJudgeGroup[]; execution: PromptExecutionMetadata }> {
	const { output, execution } = await runPrompt({
		resultSchema: routerOutputSchema,
		systemPrompt: routerPrompt,
		userPrompt: JSON.stringify({ reviewGoal, sources: sourceCatalog }),
	});

	const knownSourceIds = new Set(sourceCatalog.map(source => source.id));
	const knownChunkIds = new Set(sourceCatalog.flatMap(source => source.chunks.map(chunk => chunk.id)));
	const seenGroupIds = new Set<string>();
	const selectedGroups = output.selectedGroups.map(selection => {
		const group = judgeDefinitionsById.get(selection.id);
		if (!group) throw new Error(`Router selected an unknown judge group: ${selection.id}`);
		if (seenGroupIds.has(selection.id)) throw new Error(`Router selected duplicate judge group: ${selection.id}`);
		seenGroupIds.add(selection.id);
		const selectedSourceIds = [...new Set(selection.source_ids)];
		const selectedChunkIds = [...new Set(selection.chunk_ids)];
		for (const sourceId of selectedSourceIds) {
			if (!knownSourceIds.has(sourceId)) throw new Error(`Router selected an unknown source: ${sourceId}`);
		}
		for (const chunkId of selectedChunkIds) {
			if (!knownChunkIds.has(chunkId)) throw new Error(`Router selected an unknown chunk: ${chunkId}`);
		}
		if (selectedSourceIds.length === 0 && selectedChunkIds.length === 0) {
			throw new Error(`Router selected no context for judge group: ${selection.id}`);
		}
		return {
			...group,
			selectedSourceIds,
			selectedChunkIds,
			routeReason: selection.reason,
		};
	});
	return { selectedGroups, execution };
}

function selectSourceViews(group: RoutedJudgeGroup, sources: Source[], catalog: SemanticSourceCatalog): SourceView[] {
	const rangesBySource = new Map<string, LineRange[]>();
	const sourceCatalog = new Map(catalog.sources.map(source => [source.id, source]));
	const addRange = (sourceId: string, range: LineRange) => {
		const ranges = rangesBySource.get(sourceId) ?? [];
		ranges.push(range);
		rangesBySource.set(sourceId, ranges);
	};

	for (const sourceId of group.selectedSourceIds) {
		const source = sources.find(candidate => candidate.id === sourceId);
		if (!source) throw new Error(`Selected source disappeared: ${sourceId}`);
		addRange(sourceId, { startLine: 1, endLine: source.content.split("\n").length });
	}
	for (const chunkId of group.selectedChunkIds) {
		const chunk = catalog.chunksById.get(chunkId);
		if (!chunk) throw new Error(`Selected chunk disappeared: ${chunkId}`);
		const entry = sourceCatalog.get(chunk.sourceId);
		if (entry?.preambleEndLine) addRange(chunk.sourceId, { startLine: 1, endLine: entry.preambleEndLine });
		if (chunk.contextRange) addRange(chunk.sourceId, chunk.contextRange);
		addRange(chunk.sourceId, { startLine: chunk.startLine, endLine: chunk.endLine });
	}

	return sources.flatMap(source => {
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
	modelId,
	reviewGoal,
	riskLevel,
	runPrompt,
	sources,
	sourceViews,
}: {
	group: RoutedJudgeGroup;
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	runPrompt: PromptRunner;
	sources: Source[];
	sourceViews: SourceView[];
}): Promise<Judgment> {
	const evaluationId = randomUUID();
	const system = `${judgeProtocol}\n\n${group.prompt}`;
	const request = buildJudgeRequest({
		evaluationId,
		group,
		modelId,
		reviewGoal,
		riskLevel,
		sourceViews,
		system,
	});

	const { output, execution } = await runPrompt({
		resultSchema: judgeOutputSchema,
		systemPrompt: system,
		userPrompt: JSON.stringify(request),
	});

	try {
		validateJudgeOutput({ evaluationId, group, modelId, output });
		return {
			groupId: group.id,
			judgeType: group.judgeType,
			output: verifyEvidence(output, sources),
			execution,
		};
	} catch (error) {
		if (error instanceof EvidenceValidationError) error.execution = execution;
		throw error;
	}
}

function buildJudgeRequest({
	evaluationId,
	group,
	modelId,
	reviewGoal,
	riskLevel,
	sourceViews,
	system,
}: {
	evaluationId: string;
	group: RoutedJudgeGroup;
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	sourceViews: SourceView[];
	system: string;
}) {
	const decisionPolicy = {
		version: DECISION_POLICY_VERSION,
		mode: "analysis_only",
		calibrated_rules: [],
		auto_reject_rules: [],
		calibration_gate_passed: false,
		reversible_effect: false,
		human_review_triggers: [],
	};
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				PROMPT_VERSION,
				group.rubricVersion,
				modelId,
				OUTPUT_SCHEMA_VERSION,
				CONTEXT_LIMITS_VERSION,
				decisionPolicy.version,
			]),
		)
		.digest("hex");
	const serializedSources = sourceViews.map(serializeSourceForJudge);
	const artifact = serializedSources[0];
	if (!artifact) throw new Error("A primary artifact is required");
	const sourceTokenCounts = serializedSources.map(source => countTextTokens(JSON.stringify(source)));

	const request = {
		evaluation_id: evaluationId,
		prompt_version: PROMPT_VERSION,
		rubric_version: group.rubricVersion,
		model_id: modelId,
		output_schema_version: OUTPUT_SCHEMA_VERSION,
		context_limits_version: CONTEXT_LIMITS_VERSION,
		review_goal: reviewGoal,
		selected_group: group.id,
		artifact,
		rubric: group.criterionIds,
		allowed_sources: serializedSources.slice(1),
		context_selection: {
			source_ids: group.selectedSourceIds,
			chunk_ids: group.selectedChunkIds,
		},
		reference_data: [],
		deterministic_evidence: [],
		context_limits: {
			max_artifact_tokens: sourceTokenCounts[0] ?? 0,
			max_sources: sourceViews.length,
			max_tokens_per_source: Math.max(...sourceTokenCounts),
			max_reference_items: 0,
			max_evidence_items: 0,
			max_total_request_tokens: MAX_REQUEST_TOKENS,
		},
		context_manifest: {
			artifact_tokens: sourceTokenCounts[0] ?? 0,
			source_count: sourceViews.length,
			largest_source_tokens: Math.max(...sourceTokenCounts),
			reference_count: 0,
			evidence_count: 0,
			total_request_tokens: 0,
		},
		risk_level: riskLevel,
		calibration_context: {
			dataset_version: "example-unvalidated",
			covered_criterion_ids: [],
			in_distribution: false,
			evaluation_fingerprint: fingerprint,
		},
		decision_policy: decisionPolicy,
	};

	request.context_manifest.total_request_tokens = countTextTokens(`${system}\n${JSON.stringify(request)}`);
	if (request.context_manifest.total_request_tokens > MAX_REQUEST_TOKENS) {
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

function validateJudgeOutput({
	evaluationId,
	group,
	modelId,
	output,
}: {
	evaluationId: string;
	group: JudgeDefinition;
	modelId: string;
	output: JudgeOutput;
}) {
	if (
		output.evaluation_id !== evaluationId ||
		output.prompt_version !== PROMPT_VERSION ||
		output.rubric_version !== group.rubricVersion ||
		output.model_id !== modelId ||
		output.output_schema_version !== OUTPUT_SCHEMA_VERSION
	) {
		throw new Error(`Judge ${group.id} did not echo the evaluation contract`);
	}

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

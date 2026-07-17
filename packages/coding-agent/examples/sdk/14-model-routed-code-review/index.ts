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

const MAX_SOURCE_CHARACTERS = 200_000;
const MAX_TOTAL_SOURCE_CHARACTERS = 500_000;
const MAX_REQUEST_TOKENS = 150_000;
const PROMPT_VERSION = "model-routed-code-review/1.0.0";
const OUTPUT_SCHEMA_VERSION = "judge-output/1.0.0";
const CONTEXT_LIMITS_VERSION = "example-context-limits/1.0.0";
const DECISION_POLICY_VERSION = "analysis-only/1.0.0";
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
		location: z.string().min(1),
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

type CriterionResult = z.infer<typeof criterionResultSchema>;
type JudgeOutput = z.infer<typeof judgeOutputSchema>;

type Judgment = {
	groupId: string;
	judgeType: JudgeType;
	output: JudgeOutput;
};

type JudgeFailure = {
	groupId: string;
	judgeType: JudgeType;
	error: string;
};

export type PromptRunner = <Output>(request: {
	resultSchema: z.ZodType<Output>;
	systemPrompt: string;
	userPrompt: string;
}) => Promise<Output>;

async function createSdkPromptRunner() {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const model = modelRegistry.find("openai-codex", "gpt-5.6-luna");
	if (!model) {
		throw new Error("Model openai-codex/gpt-5.6-luna is unavailable or not authenticated");
	}

	const runPrompt: PromptRunner = async ({ resultSchema, systemPrompt, userPrompt }) => {
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
			thinkingLevel: ThinkingLevel.Low,
			toolNames: [],
		});

		let yieldDetails: unknown;
		let successfulYields = 0;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) {
				successfulYields++;
				yieldDetails = event.result.details;
			}
		});

		try {
			await session.prompt(userPrompt);
			if (successfulYields !== 1) {
				throw new Error(`SDK session produced ${successfulYields} successful terminal yields`);
			}
			if (!yieldDetails || typeof yieldDetails !== "object") {
				throw new Error("SDK session completed without yielding a result");
			}
			const result = yieldDetails as Record<string, unknown>;
			if (result.status !== "success") {
				throw new Error(`SDK session aborted: ${String(result.error ?? "unknown error")}`);
			}
			if (result.schemaOverridden === true) {
				throw new Error("SDK session exhausted yield schema retries");
			}
			const [output] = terminalSchema.parse(result.data);
			return resultSchema.parse(output);
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
	const sources = await readSources(filePaths);
	const selectedGroups = await routeReview({
		reviewGoal,
		runPrompt,
		sources,
	});
	const settledJudgments = await mapSettledWithConcurrency(selectedGroups, JUDGE_CONCURRENCY, group =>
		runJudge({
			group,
			modelId,
			reviewGoal,
			riskLevel,
			runPrompt,
			sources,
		}),
	);
	const judgments: Judgment[] = [];
	const failures: JudgeFailure[] = [];
	for (let index = 0; index < settledJudgments.length; index++) {
		const result = settledJudgments[index];
		const group = selectedGroups[index];
		if (!result || !group) throw new Error("Judge result order is inconsistent");
		if (result.status === "fulfilled") {
			judgments.push(result.value);
		} else {
			failures.push({
				groupId: group.id,
				judgeType: group.judgeType,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}

	return {
		selectedGroups: selectedGroups.map(group => group.id),
		judgments,
		failures,
		incomplete: failures.length > 0,
		aggregate: aggregateJudgments(judgments, failures.length),
	};
}
async function readSources(filePaths: string[]): Promise<Source[]> {
	const sources = await Promise.all(
		filePaths.map(async (filePath, index) => {
			const absolutePath = resolve(filePath);
			const content = await readFile(absolutePath, "utf8");
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
	sources,
}: {
	reviewGoal: string;
	runPrompt: PromptRunner;
	sources: Source[];
}): Promise<JudgeDefinition[]> {
	const output = await runPrompt({
		resultSchema: routerOutputSchema,
		systemPrompt: routerPrompt,
		userPrompt: JSON.stringify({ reviewGoal, sources }),
	});

	const selectedIds = new Set(output.selectedGroups.map(group => group.id));
	return [...selectedIds].map(id => {
		const group = judgeDefinitionsById.get(id);
		if (!group) {
			throw new Error(`Router selected an unknown judge group: ${id}`);
		}
		return group;
	});
}

async function runJudge({
	group,
	modelId,
	reviewGoal,
	riskLevel,
	runPrompt,
	sources,
}: {
	group: JudgeDefinition;
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	runPrompt: PromptRunner;
	sources: Source[];
}): Promise<Judgment> {
	const evaluationId = randomUUID();
	const system = `${judgeProtocol}\n\n${group.prompt}`;
	const request = buildJudgeRequest({
		evaluationId,
		group,
		modelId,
		reviewGoal,
		riskLevel,
		sources,
		system,
	});

	const output = await runPrompt({
		resultSchema: judgeOutputSchema,
		systemPrompt: system,
		userPrompt: JSON.stringify(request),
	});

	validateJudgeOutput({ evaluationId, group, modelId, output });
	return {
		groupId: group.id,
		judgeType: group.judgeType,
		output,
	};
}

function buildJudgeRequest({
	evaluationId,
	group,
	modelId,
	reviewGoal,
	riskLevel,
	sources,
	system,
}: {
	evaluationId: string;
	group: JudgeDefinition;
	modelId: string;
	reviewGoal: string;
	riskLevel: z.infer<typeof riskLevelSchema>;
	sources: Source[];
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
	const artifact = sources[0];
	if (!artifact) {
		throw new Error("A primary artifact is required");
	}

	const request = {
		evaluation_id: evaluationId,
		prompt_version: PROMPT_VERSION,
		rubric_version: group.rubricVersion,
		model_id: modelId,
		output_schema_version: OUTPUT_SCHEMA_VERSION,
		context_limits_version: CONTEXT_LIMITS_VERSION,
		review_goal: reviewGoal,
		selected_group: group.id,
		artifact: {
			id: artifact.id,
			content: artifact.content,
			locations: "line ranges",
		},
		rubric: group.criterionIds,
		allowed_sources: sources.slice(1),
		reference_data: [],
		deterministic_evidence: [],
		context_limits: {
			max_artifact_tokens: estimateTokens(artifact.content),
			max_sources: sources.length,
			max_tokens_per_source: Math.ceil(MAX_SOURCE_CHARACTERS / 4),
			max_reference_items: 0,
			max_evidence_items: 0,
			max_total_request_tokens: MAX_REQUEST_TOKENS,
		},
		context_manifest: {
			artifact_tokens: estimateTokens(artifact.content),
			source_count: sources.length,
			largest_source_tokens: Math.max(...sources.map(source => estimateTokens(source.content))),
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

	request.context_manifest.total_request_tokens = estimateTokens(`${system}\n${JSON.stringify(request)}`);
	if (request.context_manifest.total_request_tokens > MAX_REQUEST_TOKENS) {
		throw new Error(`Judge request for ${group.id} exceeds the context limit`);
	}

	return request;
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

function aggregateJudgments(judgments: Judgment[], failureCount: number) {
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

function estimateTokens(value: string) {
	return Math.ceil(value.length / 4);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await main();
}

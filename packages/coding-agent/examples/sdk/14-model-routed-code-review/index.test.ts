import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ZodType, z } from "zod";
import {
	type PromptRunner,
	parseCliCommand,
	prepareReviewPlan,
	runReview,
	validateTerminalYieldResult,
	writeJsonAtomic,
} from "./index";
import { judgeDefinitions } from "./prompts/registry";

const modelId = "openai-codex/gpt-5.6-luna";
const plannerRequestSchema = z
	.object({
		sourceIndex: z.object({
			sources: z.array(
				z.object({
					id: z.string(),
					fragments: z.array(z.object({ id: z.string() }).passthrough()),
				}),
			),
		}),
	})
	.passthrough();
const unavailableLsp = async () => ({ status: "unavailable" as const, symbols: "" });

function semanticPlanFromRequest(userPrompt: string) {
	const request = plannerRequestSchema.parse(JSON.parse(userPrompt));
	const owner = request.sourceIndex.sources[0];
	if (!owner) throw new Error("Expected an indexed source");
	return {
		units: [
			{
				id: "review-scope",
				behavior: "Review the supplied behavior",
				owner_source_id: owner.id,
				primary_fragment_ids: request.sourceIndex.sources.flatMap(source =>
					source.fragments.map(fragment => fragment.id),
				),
				supporting_fragment_ids: [],
				rationale: "The supplied sources form one review workflow.",
				supporting_context_reason: null,
				oversize_reason: null,
			},
		],
	};
}

describe("runReview", () => {
	test("limits concurrency and preserves successful judges when one fails", async () => {
		const failedGroup = judgeDefinitions[0];
		if (!failedGroup) throw new Error("Expected at least one judge definition");
		let activeJudges = 0;
		let maximumActiveJudges = 0;

		const runPrompt: PromptRunner = async ({
			contextTools,
			resultSchema,
			systemPrompt,
			thinkingLevel,
			userPrompt,
		}) => {
			if (systemPrompt.includes("# Planner semantic units")) {
				expect(contextTools?.mode).toBe("semantic_planning");
				return promptResult(resultSchema.parse(semanticPlanFromRequest(userPrompt)));
			}
			if (systemPrompt.includes("# Router")) {
				expect(contextTools).toBeUndefined();
				expect(thinkingLevel).toBe("xhigh");
				return promptResult(
					resultSchema.parse({
						selectedReviews: judgeDefinitions.map(group => ({
							unit_id: "review-scope",
							judge_id: group.id,
							reason: "Selected by test",
						})),
					}),
				);
			}

			expect(contextTools?.mode).toBe("read_only");
			expect(contextTools?.roots.length).toBeGreaterThan(0);
			const request = judgeRequestSchema.parse(JSON.parse(userPrompt));
			activeJudges++;
			maximumActiveJudges = Math.max(maximumActiveJudges, activeJudges);
			await Bun.sleep(10);
			activeJudges--;
			if (request.selected_group === failedGroup.id) throw new Error("simulated judge failure");

			return promptResult(
				resultSchema.parse({
					criterion_results: request.rubric.map(criterionId => ({
						criterion_id: criterionId,
						verdict: "NOT_APPLICABLE",
						severity: "minor",
						confidence: "high",
						evidence: [],
						missing_evidence: [],
						reason: "Not applicable in concurrency test.",
						suggested_action: null,
						verification_after_change: null,
					})),
				}),
			);
		};

		const result = await runReview({
			loadLspSymbols: unavailableLsp,
			filePaths: [new URL("./index.ts", import.meta.url).pathname],
			modelId,
			reviewGoal: "Exercise every judge group.",
			riskLevel: "low",
			runPrompt,
		});

		expect(maximumActiveJudges).toBe(10);
		expect(result.failures).toEqual([
			{
				unitId: "review-scope",
				groupId: failedGroup.id,
				judgeType: failedGroup.judgeType,
				error: "simulated judge failure",
			},
		]);
		expect(result.groupResults).toHaveLength(judgeDefinitions.length);
		expect(result.groupResults.filter(group => group.status === "succeeded")).toHaveLength(
			judgeDefinitions.length - 1,
		);
		expect(result.unitResults).toHaveLength(1);
		expect(result.unitResults[0]).toMatchObject({
			unitId: "review-scope",
			overallVerdict: "INSUFFICIENT_CONTEXT",
			selectedJudgeCount: judgeDefinitions.length,
			completedJudgeCount: judgeDefinitions.length - 1,
			failureCount: 1,
			incomplete: true,
		});
		expect(result.unitResults[0]?.judgeResults).toHaveLength(judgeDefinitions.length);
		expect(result.groupResults.find(group => group.groupId === failedGroup.id)).toMatchObject({
			unitId: "review-scope",
			groupId: failedGroup.id,
			judgeType: failedGroup.judgeType,
			rubricVersion: failedGroup.rubricVersion,
			status: "failed",
			failure: {
				unitId: "review-scope",
				groupId: failedGroup.id,
				judgeType: failedGroup.judgeType,
				error: "simulated judge failure",
			},
			evidenceFailures: [],
		});
		expect(result.incomplete).toBe(true);
		expect(result.aggregate).toMatchObject({
			overallVerdict: "INSUFFICIENT_CONTEXT",
			failureCount: 1,
			incomplete: true,
			selectedGroupCount: judgeDefinitions.length,
			selectedUnitCount: 1,
			completedUnitCount: 0,
			unitCounts: {
				PASS: 0,
				FAIL: 0,
				NEEDS_REVIEW: 0,
				INSUFFICIENT_CONTEXT: 1,
			},
			completedGroupCount: judgeDefinitions.length - 1,
		});
		expect(result.execution).toMatchObject({
			modelId,
			thinkingLevel: "medium",
			promptVersion: "model-routed-code-review/2.0.0",
			outputSchemaVersion: "judge-output/5.0.0",
			tokenUsage: {
				input: 14,
				output: 28,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 42,
			},
		});
		expect(result.execution.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(result.execution.durationMs).toBeGreaterThanOrEqual(0);
		expect(Object.keys(result.execution.rubricVersions)).toHaveLength(judgeDefinitions.length);
		expect(result.execution.semanticContext.routerThinkingLevel).toBe("xhigh");
	});

	test("adds a harness-computed hash to an exact source quote", async () => {
		const quote = 'import { describe, expect, test } from "bun:test";';
		const result = await runReview({
			loadLspSymbols: unavailableLsp,
			filePaths: [new URL("./index.test.ts", import.meta.url).pathname],
			modelId,
			reviewGoal: "Verify one grounded citation.",
			riskLevel: "low",
			runPrompt: createEvidenceRunner(quote),
		});

		expect(result.failures).toEqual([]);
		expect(result.groupResults).toHaveLength(1);
		expect(result.groupResults[0]).toMatchObject({
			groupId: judgeDefinitions[0]?.id,
			status: "succeeded",
		});
		expect(result.incomplete).toBe(false);
		expect(result.aggregate).toMatchObject({
			failureCount: 0,
			selectedGroupCount: 1,
			completedGroupCount: 1,
			incomplete: false,
		});
		const groupResult = result.groupResults[0];
		if (groupResult?.status !== "succeeded") throw new Error("Expected successful group result");
		const evidence = groupResult.judgment.output.criterion_results[0]?.evidence[0];
		expect(evidence).toEqual({
			source_id: "source-1:index.test.ts",
			start_line: 1,
			end_line: 1,
			quote,
			observation: "The cited import is present.",
			supports: "applies_when",
			hash: createHash("sha256").update(quote).digest("hex"),
		});
	});

	test("rejects a fabricated quote and reports evidence failures", async () => {
		const group = judgeDefinitions[0];
		if (!group) throw new Error("Expected at least one judge definition");
		const result = await runReview({
			loadLspSymbols: unavailableLsp,
			filePaths: [new URL("./index.test.ts", import.meta.url).pathname],
			modelId,
			reviewGoal: "Reject an ungrounded citation.",
			riskLevel: "low",
			runPrompt: createEvidenceRunner("fabricated source text"),
		});

		expect(result.failures).toHaveLength(1);
		expect(result.evidenceFailures).toHaveLength(group.criterionIds.length);
		expect(result.evidenceFailures[0]).toMatchObject({
			groupId: group.id,
			criterionId: group.criterionIds[0],
			evidenceIndex: 0,
			sourceId: "source-1:index.test.ts",
			error: "quote does not match lines 1-1",
		});
		expect(result.incomplete).toBe(true);
	});

	test("reviews a persisted plan without rerunning the planner", async () => {
		const group = judgeDefinitions[0];
		if (!group) throw new Error("Expected a judge definition");
		let plannerCalls = 0;
		const runPrompt: PromptRunner = async ({ resultSchema, systemPrompt, userPrompt }) => {
			if (systemPrompt.includes("# Planner semantic units")) {
				plannerCalls++;
				return promptResult(resultSchema.parse(semanticPlanFromRequest(userPrompt)));
			}
			if (systemPrompt.includes("# Router")) {
				return promptResult(
					resultSchema.parse({
						selectedReviews: [
							{
								unit_id: "review-scope",
								judge_id: group.id,
								reason: "Review the persisted unit",
							},
						],
					}),
				);
			}
			const request = judgeRequestSchema.parse(JSON.parse(userPrompt));
			return promptResult(
				resultSchema.parse({
					criterion_results: request.rubric.map(criterionId => ({
						criterion_id: criterionId,
						verdict: "NOT_APPLICABLE",
						severity: "minor",
						confidence: "high",
						evidence: [],
						missing_evidence: [],
						reason: "Not applicable in persisted-plan test.",
						suggested_action: null,
						verification_after_change: null,
					})),
				}),
			);
		};
		const filePaths = [new URL("./context-tools.ts", import.meta.url).pathname];
		const prepared = await prepareReviewPlan({
			filePaths,
			loadLspSymbols: unavailableLsp,
			reviewGoal: "Review persisted behavior",
			riskLevel: "low",
			runPrompt,
		});
		const result = await runReview({
			filePaths,
			loadLspSymbols: unavailableLsp,
			modelId,
			reviewGoal: prepared.artifact.reviewGoal,
			riskLevel: prepared.artifact.riskLevel,
			runPrompt,
			semanticPlanArtifact: prepared.artifact,
		});

		expect(plannerCalls).toBe(1);
		expect(result.execution.planner).toBeNull();
		expect(result.execution.semanticContext.planHash).toBe(prepared.artifact.planHash);
		expect(result.aggregate.incomplete).toBe(false);
	});
});

describe("persistent plan CLI", () => {
	test("parses separate plan and review stages", () => {
		expect(parseCliCommand(["plan", "--output", "plan.json", "Review errors", "src/a.ts"])).toEqual({
			command: "plan",
			outputPath: "plan.json",
			reviewGoal: "Review errors",
			filePaths: ["src/a.ts"],
		});
		expect(parseCliCommand(["review", "--output", "report.json", "--plan", "plan.json"])).toEqual({
			command: "review",
			planPath: "plan.json",
			outputPath: "report.json",
		});
		expect(() => parseCliCommand(["review", "--plan", "plan.json"])).toThrow("--output");
	});

	test("atomically writes a complete JSON result", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-review-output-"));
		const outputPath = path.join(directory, "nested", "plan.json");
		try {
			await writeJsonAtomic(outputPath, { complete: true });
			expect(await Bun.file(outputPath).json()).toEqual({ complete: true });
			expect((await fs.readdir(path.dirname(outputPath))).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("validateTerminalYieldResult", () => {
	const resultSchema = z.object({ value: z.string() }).strict();
	const valid = {
		details: { status: "success", schemaOverridden: false, data: [{ value: "ok" }] },
		incrementalYieldCount: 0,
		resultSchema,
		terminalYieldCount: 1,
	};

	test("accepts exactly one schema-valid terminal yield", () => {
		expect(validateTerminalYieldResult(valid)).toEqual({ value: "ok" });
	});

	test("rejects missing, duplicate, or incremental terminal results", () => {
		expect(() => validateTerminalYieldResult({ ...valid, terminalYieldCount: 0 })).toThrow(
			"SDK session produced 0 terminal yields",
		);
		expect(() => validateTerminalYieldResult({ ...valid, terminalYieldCount: 2 })).toThrow(
			"SDK session produced 2 terminal yields",
		);
		expect(() => validateTerminalYieldResult({ ...valid, incrementalYieldCount: 1 })).toThrow(
			"SDK session produced 1 non-terminal yields",
		);
	});

	test("rejects a yield accepted by schema override", () => {
		expect(() =>
			validateTerminalYieldResult({
				...valid,
				details: { ...valid.details, schemaOverridden: true },
			}),
		).toThrow("SDK session exhausted yield schema retries");
	});
});
const judgeRequestSchema = z.object({ selected_group: z.string(), rubric: z.array(z.string()) }).passthrough();

function createEvidenceRunner(quote: string): PromptRunner {
	const group = judgeDefinitions[0];
	if (!group) throw new Error("Expected at least one judge definition");
	return async <Output>({
		resultSchema,
		systemPrompt,
		userPrompt,
	}: {
		resultSchema: ZodType<Output>;
		systemPrompt: string;
		userPrompt: string;
	}) => {
		if (systemPrompt.includes("# Planner semantic units")) {
			return promptResult(resultSchema.parse(semanticPlanFromRequest(userPrompt)));
		}
		if (systemPrompt.includes("# Router")) {
			return promptResult(
				resultSchema.parse({
					selectedReviews: [
						{
							unit_id: "review-scope",
							judge_id: group.id,
							reason: "Selected by evidence test",
						},
					],
				}),
			);
		}
		const request = judgeRequestSchema.parse(JSON.parse(userPrompt));
		return promptResult(
			resultSchema.parse({
				criterion_results: request.rubric.map(criterionId => ({
					criterion_id: criterionId,
					verdict: "NOT_APPLICABLE",
					severity: "minor",
					confidence: "high",
					evidence: [
						{
							source_id: "source-1:index.test.ts",
							start_line: 1,
							end_line: 1,
							quote,
							observation: "The cited import is present.",
							supports: "applies_when",
						},
					],
					missing_evidence: [],
					reason: "Not applicable in evidence test.",
					suggested_action: null,
					verification_after_change: null,
				})),
			}),
		);
	};
}

function promptResult<Output>(output: Output) {
	return {
		output,
		execution: {
			durationMs: 5,
			contextTools: { enabled: false, maxCalls: 0, requestedCalls: 0, blockedCalls: 0, callsByTool: {} },
			tokenUsage: {
				input: 1,
				output: 2,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
			},
		},
	};
}

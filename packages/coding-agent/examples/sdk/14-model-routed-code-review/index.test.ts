import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { runReview, type PromptRunner } from "./index";
import { judgeDefinitions } from "./prompts/registry";

const modelId = "openai-codex/gpt-5.6-luna";

describe("runReview", () => {
	test("limits concurrency and preserves successful judges when one fails", async () => {
		const failedGroup = judgeDefinitions[0];
		if (!failedGroup) throw new Error("Expected at least one judge definition");
		let activeJudges = 0;
		let maximumActiveJudges = 0;

		const runPrompt: PromptRunner = async <Output>({
			systemPrompt,
			userPrompt,
		}: {
			resultSchema: ZodType<Output>;
			systemPrompt: string;
			userPrompt: string;
		}) => {
			if (systemPrompt.includes("# Router")) {
				return {
					selectedGroups: judgeDefinitions.map(group => ({ id: group.id, reason: "Selected by test" })),
				} as Output;
			}

			const request = JSON.parse(userPrompt) as JudgeRequest;
			activeJudges++;
			maximumActiveJudges = Math.max(maximumActiveJudges, activeJudges);
			await Bun.sleep(10);
			activeJudges--;
			if (request.selected_group === failedGroup.id) throw new Error("simulated judge failure");

			return {
				evaluation_id: request.evaluation_id,
				prompt_version: request.prompt_version,
				rubric_version: request.rubric_version,
				model_id: request.model_id,
				output_schema_version: request.output_schema_version,
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
				overall_verdict: "PASS",
				automation_decision: "ANALYSIS_ONLY",
				escalation_required: false,
				escalation_reasons: [],
			} as Output;
		};

		const result = await runReview({
			filePaths: [new URL("./index.ts", import.meta.url).pathname],
			modelId,
			reviewGoal: "Exercise every judge group.",
			riskLevel: "low",
			runPrompt,
		});

		expect(maximumActiveJudges).toBe(10);
		expect(result.failures).toEqual([
			{
				groupId: failedGroup.id,
				judgeType: failedGroup.judgeType,
				error: "simulated judge failure",
			},
		]);
		expect(result.groupResults).toHaveLength(judgeDefinitions.length);
		expect(result.groupResults.filter(group => group.status === "succeeded")).toHaveLength(
			judgeDefinitions.length - 1,
		);
		expect(result.groupResults.find(group => group.groupId === failedGroup.id)).toEqual({
			groupId: failedGroup.id,
			judgeType: failedGroup.judgeType,
			status: "failed",
			failure: {
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
			completedGroupCount: judgeDefinitions.length - 1,
		});
	});

	test("adds a harness-computed hash to an exact source quote", async () => {
		const quote = 'import { describe, expect, test } from "bun:test";';
		const result = await runReview({
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
		if (!groupResult || groupResult.status !== "succeeded") throw new Error("Expected successful group result");
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
});

type JudgeRequest = {
	evaluation_id: string;
	prompt_version: string;
	rubric_version: string;
	model_id: string;
	output_schema_version: string;
	selected_group: string;
	rubric: string[];
};

function createEvidenceRunner(quote: string): PromptRunner {
	const group = judgeDefinitions[0];
	if (!group) throw new Error("Expected at least one judge definition");
	return async <Output>({
		systemPrompt,
		userPrompt,
	}: {
		resultSchema: ZodType<Output>;
		systemPrompt: string;
		userPrompt: string;
	}) => {
		if (systemPrompt.includes("# Router")) {
			return { selectedGroups: [{ id: group.id, reason: "Selected by evidence test" }] } as Output;
		}
		const request = JSON.parse(userPrompt) as JudgeRequest;
		return {
			evaluation_id: request.evaluation_id,
			prompt_version: request.prompt_version,
			rubric_version: request.rubric_version,
			model_id: request.model_id,
			output_schema_version: request.output_schema_version,
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
			overall_verdict: "PASS",
			automation_decision: "ANALYSIS_ONLY",
			escalation_required: false,
			escalation_reasons: [],
		} as Output;
	};
}

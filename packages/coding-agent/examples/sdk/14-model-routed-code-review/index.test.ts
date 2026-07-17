import { describe, expect, test } from "bun:test";
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
		expect(result.judgments).toHaveLength(judgeDefinitions.length - 1);
		expect(result.failures).toEqual([
			{
				groupId: failedGroup.id,
				judgeType: failedGroup.judgeType,
				error: "simulated judge failure",
			},
		]);
		expect(result.incomplete).toBe(true);
		expect(result.aggregate).toMatchObject({
			overallVerdict: "INSUFFICIENT_CONTEXT",
			failureCount: 1,
			incomplete: true,
		});
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

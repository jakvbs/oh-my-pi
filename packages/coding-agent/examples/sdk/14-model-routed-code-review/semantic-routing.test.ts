import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import { runReview, type PromptRunner } from "./index";
import { judgeDefinitions } from "./prompts/registry";

const modelId = "openai-codex/gpt-5.6-luna";

test("routes a large source to one semantic chunk while preserving original lines", async () => {
	const directory = await mkdtemp(join(tmpdir(), "model-routed-review-"));
	const filePath = join(directory, "large.ts");
	const repeatedBody = Array.from({ length: 2_000 }, (_, index) => `\tconst value${index} = ${index};`).join("\n");
	const source = [
		'import { readFile } from "node:fs/promises";',
		"export function alpha() {",
		repeatedBody,
		"\treturn readFile;",
		"}",
		"export function beta() {",
		repeatedBody.replaceAll("value", "other"),
		"\treturn 2;",
		"}",
	].join("\n");
	await writeFile(filePath, source);

	let selectedChunkId = "";
	const group = judgeDefinitions[0];
	if (!group) throw new Error("Expected a judge definition");
	const runPrompt: PromptRunner = async <Output>({
		systemPrompt,
		userPrompt,
	}: {
		resultSchema: ZodType<Output>;
		systemPrompt: string;
		userPrompt: string;
	}) => {
		if (systemPrompt.includes("# Router")) {
			const request = JSON.parse(userPrompt) as RouterRequest;
			const sourceEntry = request.sources[0];
			if (!sourceEntry?.chunked || sourceEntry.chunks.length < 2) {
				throw new Error("Large TypeScript source was not semantically chunked");
			}
			const alphaChunk = sourceEntry.chunks.find(chunk => chunk.label.includes("alpha"));
			if (!alphaChunk) throw new Error("Alpha callable chunk was not cataloged");
			selectedChunkId = alphaChunk.id;
			return promptResult({
				selectedGroups: [
					{
						id: group.id,
						reason: "Review alpha only",
						source_ids: [],
						chunk_ids: [alphaChunk.id],
					},
				],
			} as Output);
		}

		const request = JSON.parse(userPrompt) as JudgeRequest;
		const selectedLines = request.artifact.content.ranges.flatMap(range => range.lines);
		if (selectedLines.some(line => line.text.includes("function beta"))) {
			throw new Error("Unselected beta callable leaked into judge context");
		}
		const evidenceLine = selectedLines[0];
		if (!evidenceLine) throw new Error("Selected chunk contained no source lines");
		return promptResult({
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
						source_id: request.artifact.id,
						start_line: evidenceLine.number,
						end_line: evidenceLine.number,
						quote: evidenceLine.text,
						observation: "The selected source line is present.",
						supports: "applies_when",
					},
				],
				missing_evidence: [],
				reason: "Not applicable in semantic routing test.",
				suggested_action: null,
				verification_after_change: null,
			})),
			overall_verdict: "PASS",
			automation_decision: "ANALYSIS_ONLY",
			escalation_required: false,
			escalation_reasons: [],
		} as Output);
	};

	try {
		const result = await runReview({
			filePaths: [filePath],
			modelId,
			reviewGoal: "Review only alpha.",
			riskLevel: "low",
			runPrompt,
		});
		const groupResult = result.groupResults[0];
		expect(groupResult).toMatchObject({
			groupId: group.id,
			selectedSourceIds: [],
			selectedChunkIds: [selectedChunkId],
			status: "succeeded",
		});
		expect(result.execution.semanticContext).toMatchObject({
			chunkedSourceCount: 1,
			selectedSourceCount: 0,
			selectedChunkCount: 1,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

type RouterRequest = {
	sources: Array<{
		id: string;
		chunked: boolean;
		chunks: Array<{ id: string; label: string; startLine: number; endLine: number }>;
	}>;
};

type JudgeRequest = {
	evaluation_id: string;
	prompt_version: string;
	rubric_version: string;
	model_id: string;
	output_schema_version: string;
	rubric: string[];
	artifact: {
		id: string;
		content: {
			ranges: Array<{
				start_line: number;
				end_line: number;
				lines: Array<{ number: number; text: string }>;
			}>;
		};
	};
};

function promptResult<Output>(output: Output) {
	return {
		output,
		execution: {
			durationMs: 1,
			tokenUsage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		},
	};
}

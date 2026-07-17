import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ZodType, z } from "zod";
import { type PromptRunner, runReview } from "./index";
import { judgeDefinitions } from "./prompts/registry";
import { buildSemanticSourceCatalog } from "./semantic-chunks";

const modelId = "openai-codex/gpt-5.6-luna";
const plannerRequestSchema = z
	.object({
		sourceIndex: z.object({
			sources: z.array(
				z.object({
					id: z.string(),
					fragments: z.array(
						z.object({
							id: z.string(),
							label: z.string(),
							estimatedTokens: z.number(),
						}),
					),
				}),
			),
			relations: z.array(
				z.object({
					fromFragmentId: z.string(),
					toFragmentId: z.string(),
					kind: z.string(),
					strength: z.string(),
				}),
			),
		}),
	})
	.passthrough();
const judgeRequestSchema = z
	.object({
		rubric: z.array(z.string()),
		semantic_unit: z.object({ id: z.string() }).passthrough(),
		artifact: z.object({
			id: z.string(),
			content: z.object({
				ranges: z.array(
					z.object({
						lines: z.array(z.object({ number: z.number(), text: z.string() })),
					}),
				),
			}),
		}),
	})
	.passthrough();

const unavailableLsp = async () => ({ status: "unavailable" as const, symbols: "" });

test("atomizes multi-behavior code, tests, and prompts below the former large-file threshold", async () => {
	const body = Array.from({ length: 180 }, (_, index) => `	const value${index} = ${index};`).join("\n");
	const prose = Array.from({ length: 220 }, (_, index) => `Criterion ${index} preserves an observable contract.`).join(
		"\n",
	);
	const catalog = await buildSemanticSourceCatalog([
		{
			id: "source-1:workflow.ts",
			path: "/repo/workflow.ts",
			content: [
				"export function alpha() {",
				body,
				"}",
				"export function beta() {",
				body.replaceAll("value", "other"),
				"}",
			].join("\n"),
		},
		{
			id: "source-2:workflow.test.ts",
			path: "/repo/workflow.test.ts",
			content: [
				'import { test } from "bun:test";',
				'test("alpha contract", () => {',
				body,
				"});",
				'test("beta contract", () => {',
				body.replaceAll("value", "other"),
				"});",
			].join("\n"),
		},
		{
			id: "source-3:rubric.md",
			path: "/repo/rubric.md",
			content: ["# Review rubric", "## Alpha policy", prose, "## Beta policy", prose].join("\n"),
		},
	]);

	expect(catalog.sources.every(source => source.estimatedTokens < 12_000)).toBe(true);
	expect(catalog.sources).toEqual([
		expect.objectContaining({
			chunked: true,
			chunks: expect.arrayContaining([
				expect.objectContaining({ label: expect.stringContaining("alpha") }),
				expect.objectContaining({ label: expect.stringContaining("beta") }),
			]),
		}),
		expect.objectContaining({
			chunked: true,
			chunks: expect.arrayContaining([
				expect.objectContaining({ label: expect.stringContaining("alpha contract") }),
				expect.objectContaining({ label: expect.stringContaining("beta contract") }),
			]),
		}),
		expect.objectContaining({
			chunked: true,
			chunks: expect.arrayContaining([
				expect.objectContaining({ label: "## Alpha policy" }),
				expect.objectContaining({ label: "## Beta policy" }),
			]),
		}),
	]);
});

test("plans large source as complete semantic units and routes each unit independently", async () => {
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

	const selectedByUnit = new Map<string, string[]>();
	const group = judgeDefinitions[0];
	if (!group) throw new Error("Expected a judge definition");
	const runPrompt: PromptRunner = async <Output>({
		resultSchema,
		systemPrompt,
		userPrompt,
	}: {
		resultSchema: ZodType<Output>;
		systemPrompt: string;
		userPrompt: string;
	}) => {
		if (systemPrompt.includes("# Planner semantic units")) {
			const request = plannerRequestSchema.parse(JSON.parse(userPrompt));
			const sourceEntry = request.sourceIndex.sources[0];
			if (!sourceEntry || sourceEntry.fragments.length < 2) {
				throw new Error("Large TypeScript source was not semantically fragmented");
			}
			if (sourceEntry.fragments.some(fragment => fragment.estimatedTokens > 6_000)) {
				throw new Error("Source fragment exceeded the native token budget");
			}
			expect(request.sourceIndex.relations).toContainEqual(
				expect.objectContaining({ kind: "same-source-adjacent", strength: "medium" }),
			);
			const alphaIds = sourceEntry.fragments
				.filter(fragment => fragment.label.includes("alpha"))
				.map(fragment => fragment.id);
			const betaIds = sourceEntry.fragments
				.filter(fragment => fragment.label.includes("beta"))
				.map(fragment => fragment.id);
			if (alphaIds.length === 0 || betaIds.length === 0) throw new Error("Expected alpha and beta fragments");
			const behaviorIds = new Set([...alphaIds, ...betaIds]);
			const sharedIds = sourceEntry.fragments
				.filter(fragment => !behaviorIds.has(fragment.id))
				.map(fragment => fragment.id);
			return promptResult(
				resultSchema.parse({
					units: [
						{
							id: "alpha-workflow",
							behavior: "Resolve alpha through its file-read dependency",
							owner_source_id: sourceEntry.id,
							primary_fragment_ids: [...sharedIds, ...alphaIds],
							supporting_fragment_ids: [],
							rationale: "Alpha owns the module preamble and its complete callable.",
							supporting_context_reason: null,
							oversize_reason: null,
						},
						{
							id: "beta-workflow",
							behavior: "Compute beta independently",
							owner_source_id: sourceEntry.id,
							primary_fragment_ids: betaIds,
							supporting_fragment_ids: [],
							rationale: "Beta is an independently reviewable callable.",
							supporting_context_reason: null,
							oversize_reason: null,
						},
					],
				}),
			);
		}
		if (systemPrompt.includes("# Router")) {
			return promptResult(
				resultSchema.parse({
					selectedReviews: ["alpha-workflow", "beta-workflow"].map(unitId => ({
						unit_id: unitId,
						judge_id: group.id,
						reason: "Review the independently planned behavior",
					})),
				}),
			);
		}

		const request = judgeRequestSchema.parse(JSON.parse(userPrompt));
		const selectedLines = request.artifact.content.ranges.flatMap(range => range.lines);
		selectedByUnit.set(
			request.semantic_unit.id,
			selectedLines.map(line => line.text),
		);
		const evidenceLine = selectedLines[0];
		if (!evidenceLine) throw new Error("Selected unit contained no source lines");
		return promptResult(
			resultSchema.parse({
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
			}),
		);
	};

	try {
		const result = await runReview({
			filePaths: [filePath],
			loadLspSymbols: unavailableLsp,
			modelId,
			reviewGoal: "Review alpha and beta as independent behaviors.",
			riskLevel: "low",
			runPrompt,
		});
		expect(result.semanticUnits).toHaveLength(2);
		expect(result.groupResults).toHaveLength(2);
		expect(result.unitResults).toHaveLength(2);
		expect(result.unitResults.map(unit => unit.unitId)).toEqual(["alpha-workflow", "beta-workflow"]);
		expect(result.aggregate).toMatchObject({
			selectedUnitCount: 2,
			completedUnitCount: 2,
			unitCounts: { PASS: 2, FAIL: 0, NEEDS_REVIEW: 0, INSUFFICIENT_CONTEXT: 0 },
		});
		expect(selectedByUnit.get("alpha-workflow")?.some(line => line.includes("function beta"))).toBe(false);
		expect(selectedByUnit.get("beta-workflow")?.some(line => line.includes("function alpha"))).toBe(false);
		expect(result.execution.semanticContext).toMatchObject({
			sourceCount: 1,
			unitCount: 2,
		});
		expect(result.execution.semanticContext.fragmentCount).toBeGreaterThanOrEqual(2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function promptResult<Output>(output: Output) {
	return {
		output,
		execution: {
			durationMs: 1,
			contextTools: { enabled: false, maxCalls: 0, requestedCalls: 0, blockedCalls: 0, callsByTool: {} },
			tokenUsage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		},
	};
}

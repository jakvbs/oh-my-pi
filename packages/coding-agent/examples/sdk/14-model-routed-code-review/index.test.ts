import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ZodType } from "zod";
import { parsePlanArtifact } from "./artifact-codec";
import {
	PLAN_SCHEMA_VERSION,
	type PlanArtifact,
	PROMPT_VERSION,
	type PromptResult,
	type PromptRunner,
	type PromptStage,
	type ReviewReport,
	type UnitReviewArtifact,
	type ValidatedPlan,
} from "./contracts";
import type { GuideId } from "./guide-catalog";
import {
	aggregateReview,
	type Clock,
	createReviewPlan,
	type HashFn,
	reviewUnit,
	reviewUnits,
	runReview,
	type SourceLoader,
} from "./index";

const emptyUsage = {
	input: 1,
	output: 1,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
};

const FIXED_START = "2026-01-15T12:00:00.000Z";
const MODEL_ID = "test-model";
const THINKING = ThinkingLevel.Medium;

const hash: HashFn = canonical => createHash("sha256").update(canonical).digest("hex");

function createClock(startIso = FIXED_START): Clock & { advance(ms: number): void } {
	let currentMs = Date.parse(startIso);
	return {
		now() {
			return new Date(currentMs).toISOString();
		},
		advance(ms: number) {
			currentMs += ms;
		},
	};
}

function filesystemSourceLoader(): SourceLoader {
	return {
		async snapshot(paths) {
			return await Promise.all(
				paths.map(async filePath => {
					const absolutePath = path.resolve(filePath);
					return {
						path: absolutePath,
						content: await fs.readFile(absolutePath, "utf8"),
					};
				}),
			);
		},
	};
}

function promptResult<Output>(
	resultSchema: ZodType<Output>,
	stage: PromptStage,
	value: unknown,
	contextReadPaths: string[] = [],
): PromptResult<Output> {
	return {
		output: resultSchema.parse(value),
		execution: {
			stage,
			durationMs: 1,
			tokenUsage: emptyUsage,
			contextTools: {
				enabled: stage !== "aggregator",
				maxCalls: stage === "aggregator" ? 0 : 24,
				requestedCalls: contextReadPaths.length,
				blockedCalls: 0,
				callsByTool: contextReadPaths.length > 0 ? { read: contextReadPaths.length } : {},
			},
		},
		contextReadPaths,
	};
}

function extractJsonBlock(userPrompt: string): unknown {
	const match = /```json\n([\s\S]*?)\n```/.exec(userPrompt);
	if (!match?.[1]) {
		throw new Error("Prompt is missing a fenced JSON request block");
	}
	return JSON.parse(match[1]);
}

function reviewerUnitId(userPrompt: string): string {
	const payload = extractJsonBlock(userPrompt) as { unit?: { id?: string } };
	const unitId = payload.unit?.id;
	if (!unitId) {
		throw new Error("Reviewer prompt is missing unit.id");
	}
	return unitId;
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temporaryPath = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporaryPath, destination);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function withTempWorkspace(
	files: Record<string, string>,
	run: (ctx: {
		cwd: string;
		paths: Record<string, string>;
		roots: string[];
		sourceLoader: SourceLoader;
		clock: Clock & { advance(ms: number): void };
	}) => Promise<void>,
): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "model-routed-review-"));
	const paths: Record<string, string> = {};
	try {
		for (const [name, content] of Object.entries(files)) {
			const filePath = path.join(cwd, name);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, "utf8");
			paths[name] = filePath;
		}
		await run({
			cwd,
			paths,
			roots: [cwd],
			sourceLoader: filesystemSourceLoader(),
			clock: createClock(),
		});
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function lineQuote(content: string, startLine: number, endLine = startLine): string {
	const lines = content.split(/\r?\n/);
	return lines.slice(startLine - 1, endLine).join("\n");
}

function plannerUnits(
	entries: Array<{
		id: string;
		filePath: string;
		title?: string;
		riskLevel?: "low" | "medium" | "high" | "critical";
		reviewFocus?: string[];
		relatedFiles?: string[];
		guideIds?: GuideId[];
	}>,
) {
	return entries.map(entry => ({
		id: entry.id,
		title: entry.title ?? entry.id,
		objective: `Review ${entry.id}`,
		primary_files: [entry.filePath],
		related_files: entry.relatedFiles ?? [],
		review_focus: entry.reviewFocus ?? ["correctness"],
		guide_ids: entry.guideIds ?? ["contract/state-lifecycle"],
		risk_level: entry.riskLevel ?? "medium",
		rationale: `Owns ${entry.id}`,
	}));
}

function passReview(unitId: string, filePath: string) {
	return {
		unit_id: unitId,
		verdict: "PASS" as const,
		summary: `${unitId} looks sound`,
		findings: [],
		coverage: [{ path: filePath, status: "reviewed" as const, notes: "Read complete implementation" }],
	};
}

function findingReview(input: {
	unitId: string;
	filePath: string;
	fileContent: string;
	findingId: string;
	severity: "heuristic" | "minor" | "major" | "critical";
	confidence?: "low" | "medium" | "high";
	startLine: number;
	endLine?: number;
	title?: string;
	guideIds?: GuideId[];
}) {
	const endLine = input.endLine ?? input.startLine;
	const quote = lineQuote(input.fileContent, input.startLine, endLine);
	return {
		unit_id: input.unitId,
		verdict:
			input.severity === "major" || input.severity === "critical" ? ("FAIL" as const) : ("NEEDS_REVIEW" as const),
		summary: `${input.unitId} has a defect`,
		findings: [
			{
				id: input.findingId,
				title: input.title ?? `${input.unitId} defect`,
				category: "correctness",
				severity: input.severity,
				confidence: input.confidence ?? "high",
				...(input.guideIds ? { guide_ids: input.guideIds } : {}),
				evidence: [
					{
						source_id: input.filePath,
						start_line: input.startLine,
						end_line: endLine,
						quote,
						observation: "Exact source lines support the finding",
					},
				],
				reason: "Observed defect in the cited lines",
				suggested_action: "Repair the cited behavior",
				verification_after_change: "Re-read the cited lines after the fix",
			},
		],
		coverage: [{ path: input.filePath, status: "reviewed" as const, notes: "Read complete implementation" }],
	};
}

async function createValidatedPlan(input: {
	cwd: string;
	roots: string[];
	targetFiles: string[];
	reviewGoal: string;
	riskLevel?: "low" | "medium" | "high" | "critical";
	sourceLoader: SourceLoader;
	clock: Clock;
	runPrompt: PromptRunner;
}): Promise<{ artifact: PlanArtifact; plan: ValidatedPlan }> {
	const created = await createReviewPlan(
		{
			reviewGoal: input.reviewGoal,
			riskLevel: input.riskLevel ?? "medium",
			targetFiles: input.targetFiles,
			cwd: input.cwd,
			roots: input.roots,
		},
		{
			runPrompt: input.runPrompt,
			sourceLoader: input.sourceLoader,
			clock: input.clock,
			hash,
			thinkingLevel: THINKING,
		},
	);
	expect(created.ok).toBe(true);
	if (!created.ok) {
		throw new Error(created.failure.message);
	}

	const validated = parsePlanArtifact(created.value, {
		cwd: input.cwd,
		roots: [...input.roots],
		targetFiles: [...input.targetFiles],
		sourceFingerprint: created.value.sourceFingerprint,
		hash,
	});
	expect(validated.ok).toBe(true);
	if (!validated.ok) {
		throw new Error(validated.failure.message);
	}

	return { artifact: created.value, plan: validated.value };
}

function reportContract(report: ReviewReport) {
	return {
		reviewGoal: report.reviewGoal,
		riskLevel: report.riskLevel,
		incomplete: report.incomplete,
		planFingerprint: report.planFingerprint,
		aggregate: {
			summary: report.aggregate.summary,
			counts: report.aggregate.counts,
			verdict: report.aggregate.verdict,
		},
		findings: report.findings.map(finding => ({
			id: finding.id,
			sourceFindings: finding.sourceFindings,
			unitIds: finding.unitIds,
			title: finding.title,
			categories: finding.categories,
			severity: finding.severity,
			confidence: finding.confidence,
			guideIds: finding.guideIds,
			reason: finding.reason,
			suggestedAction: finding.suggestedAction,
			verificationAfterChange: finding.verificationAfterChange,
			evidence: finding.evidence.map(item => ({
				sourceId: item.sourceId,
				startLine: item.startLine,
				endLine: item.endLine,
				quote: item.quote,
				observation: item.observation,
				hash: item.hash,
			})),
		})),
		coverageGaps: report.coverageGaps,
		units: report.units.map(artifact =>
			artifact.status === "succeeded"
				? {
						unitId: artifact.unitId,
						unitFingerprint: artifact.unitFingerprint,
						status: artifact.status,
						verdict: artifact.review.verdict,
						findingIds: artifact.review.findings.map(finding => finding.id),
					}
				: {
						unitId: artifact.unitId,
						unitFingerprint: artifact.unitFingerprint,
						status: artifact.status,
						failure: {
							kind: artifact.failure.kind,
							...(artifact.failure.kind === "invalid_coverage" ||
							artifact.failure.kind === "invalid_evidence" ||
							artifact.failure.kind === "prompt_failed"
								? { message: artifact.failure.message }
								: {}),
						},
					},
		),
	};
}

describe("createReviewPlan", () => {
	test("yields an editable versioned PlanArtifact without invoking the reviewer", async () => {
		await withTempWorkspace(
			{
				"a.ts": "export const a = 1;\n",
				"b.ts": "export const b = 2;\n",
			},
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const stages: PromptStage[] = [];
				const runPrompt: PromptRunner = async ({ resultSchema, stage }) => {
					stages.push(stage);
					if (stage !== "planner") {
						throw new Error(`Unexpected stage ${stage}`);
					}
					return promptResult(resultSchema, stage, {
						overview: "Two owners",
						units: plannerUnits([
							{ id: "unit-a", filePath: paths["a.ts"]!, reviewFocus: ["exports"] },
							{ id: "unit-b", filePath: paths["b.ts"]!, reviewFocus: ["exports"] },
						]),
					});
				};

				const outcome = await createReviewPlan(
					{
						reviewGoal: "Review modules",
						riskLevel: "high",
						targetFiles: [paths["a.ts"]!, paths["b.ts"]!],
						cwd,
						roots,
					},
					{ runPrompt, sourceLoader, clock, hash, thinkingLevel: THINKING },
				);

				expect(outcome.ok).toBe(true);
				if (!outcome.ok) {
					throw new Error(outcome.failure.message);
				}

				expect(stages).toEqual(["planner"]);
				expect(outcome.value).toMatchObject({
					schemaVersion: PLAN_SCHEMA_VERSION,
					promptVersion: PROMPT_VERSION,
					reviewGoal: "Review modules",
					riskLevel: "high",
					createdAt: FIXED_START,
				});
				expect(outcome.value.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
				expect(outcome.value.units.map(unit => unit.id)).toEqual(["unit-a", "unit-b"]);

				outcome.value.units[0]!.reviewFocus = ["edited-focus"];
				expect(outcome.value.units[0]!.reviewFocus).toEqual(["edited-focus"]);
			},
		);
	});
});

describe("reviewUnit", () => {
	test("stable unit id executes exactly one unit review", async () => {
		await withTempWorkspace(
			{
				"a.ts": "export const a = 1;\n",
				"b.ts": "export const b = 2;\n",
			},
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const reviewed: string[] = [];
				const planner: PromptRunner = async ({ resultSchema, stage }) => {
					expect(stage).toBe("planner");
					return promptResult(resultSchema, stage, {
						overview: "Two units",
						units: plannerUnits([
							{ id: "unit-a", filePath: paths["a.ts"]! },
							{ id: "unit-b", filePath: paths["b.ts"]! },
						]),
					});
				};
				const { plan } = await createValidatedPlan({
					cwd,
					roots,
					targetFiles: [paths["a.ts"]!, paths["b.ts"]!],
					reviewGoal: "Review modules",
					sourceLoader,
					clock,
					runPrompt: planner,
				});

				const runPrompt: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
					expect(stage).toBe("reviewer");
					const unitId = reviewerUnitId(userPrompt);
					reviewed.push(unitId);
					return promptResult(resultSchema, stage, passReview(unitId, paths["a.ts"]!), [paths["a.ts"]!]);
				};

				const artifact = await reviewUnit(
					{ plan, unitId: "unit-a", cwd, roots },
					{ runPrompt, sourceLoader, hash, thinkingLevel: THINKING },
				);

				expect(reviewed).toEqual(["unit-a"]);
				expect(artifact).toMatchObject({
					status: "succeeded",
					unitId: "unit-a",
					planFingerprint: plan.planFingerprint,
					unitFingerprint: plan.units[0]!.unitFingerprint,
				});
				if (artifact.status !== "succeeded") {
					throw new Error("expected succeeded artifact");
				}
				expect(artifact.review.coverage[0]).toMatchObject({ path: paths["a.ts"], status: "reviewed" });
			},
		);
	});

	test("prompt rejection, invalid coverage, and invalid evidence become terminal failed artifacts", async () => {
		await withTempWorkspace(
			{ "source.ts": "export const value = 1;\n" },
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const sourcePath = paths["source.ts"]!;
				const sourceContent = "export const value = 1;\n";
				const planner: PromptRunner = async ({ resultSchema, stage }) =>
					promptResult(resultSchema, stage, {
						overview: "One unit",
						units: plannerUnits([{ id: "source", filePath: sourcePath }]),
					});
				const { plan } = await createValidatedPlan({
					cwd,
					roots,
					targetFiles: [sourcePath],
					reviewGoal: "Review source",
					sourceLoader,
					clock,
					runPrompt: planner,
				});

				const rejected = await reviewUnit(
					{ plan, unitId: "source", cwd, roots },
					{
						runPrompt: async () => {
							throw new Error("reviewer transport failed");
						},
						sourceLoader,
						hash,
						thinkingLevel: THINKING,
					},
				);
				expect(rejected).toMatchObject({
					status: "failed",
					unitId: "source",
					failure: { kind: "prompt_failed", stage: "reviewer", message: "reviewer transport failed" },
				});

				const badCoverage = await reviewUnit(
					{ plan, unitId: "source", cwd, roots },
					{
						runPrompt: async ({ resultSchema, stage }) =>
							promptResult(resultSchema, stage, passReview("source", sourcePath), []),
						sourceLoader,
						hash,
						thinkingLevel: THINKING,
					},
				);
				expect(badCoverage.status).toBe("failed");
				if (badCoverage.status !== "failed") {
					throw new Error("expected failed coverage artifact");
				}
				expect(badCoverage.failure.kind).toBe("invalid_coverage");

				const badEvidence = await reviewUnit(
					{ plan, unitId: "source", cwd, roots },
					{
						runPrompt: async ({ resultSchema, stage }) =>
							promptResult(
								resultSchema,
								stage,
								{
									unit_id: "source",
									verdict: "FAIL",
									summary: "Fabricated",
									findings: [
										{
											id: "fabricated",
											title: "Fabricated",
											category: "correctness",
											severity: "major",
											confidence: "high",
											evidence: [
												{
													source_id: sourcePath,
													start_line: 1,
													end_line: 1,
													quote: "export const value = 2;",
													observation: "Does not match disk",
												},
											],
											reason: "Fabricated quote",
											suggested_action: "None",
											verification_after_change: "Re-read",
										},
									],
									coverage: [{ path: sourcePath, status: "reviewed", notes: "Read" }],
								},
								[sourcePath],
							),
						sourceLoader,
						hash,
						thinkingLevel: THINKING,
					},
				);
				expect(badEvidence.status).toBe("failed");
				if (badEvidence.status !== "failed") {
					throw new Error("expected failed evidence artifact");
				}
				expect(badEvidence.failure.kind).toBe("invalid_evidence");
				expect(lineQuote(sourceContent, 1)).toBe("export const value = 1;");
			},
		);
	});

	test("independent reviewUnit calls share no runtime state", async () => {
		await withTempWorkspace(
			{
				"a.ts": "export const a = 1;\n",
				"b.ts": "export const b = 2;\n",
			},
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const planner: PromptRunner = async ({ resultSchema, stage }) =>
					promptResult(resultSchema, stage, {
						overview: "Independent",
						units: plannerUnits([
							{ id: "unit-a", filePath: paths["a.ts"]! },
							{ id: "unit-b", filePath: paths["b.ts"]! },
						]),
					});
				const { plan } = await createValidatedPlan({
					cwd,
					roots,
					targetFiles: [paths["a.ts"]!, paths["b.ts"]!],
					reviewGoal: "Review modules",
					sourceLoader,
					clock,
					runPrompt: planner,
				});

				const seenA: string[] = [];
				const seenB: string[] = [];
				const runnerA: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
					const unitId = reviewerUnitId(userPrompt);
					seenA.push(unitId);
					return promptResult(resultSchema, stage, passReview(unitId, paths["a.ts"]!), [paths["a.ts"]!]);
				};
				const runnerB: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
					const unitId = reviewerUnitId(userPrompt);
					seenB.push(unitId);
					return promptResult(resultSchema, stage, passReview(unitId, paths["b.ts"]!), [paths["b.ts"]!]);
				};

				const [artifactA, artifactB] = await Promise.all([
					reviewUnit(
						{ plan, unitId: "unit-a", cwd, roots },
						{ runPrompt: runnerA, sourceLoader, hash, thinkingLevel: THINKING },
					),
					reviewUnit(
						{ plan, unitId: "unit-b", cwd, roots },
						{ runPrompt: runnerB, sourceLoader, hash, thinkingLevel: THINKING },
					),
				]);

				expect(seenA).toEqual(["unit-a"]);
				expect(seenB).toEqual(["unit-b"]);
				expect(artifactA).toMatchObject({ status: "succeeded", unitId: "unit-a" });
				expect(artifactB).toMatchObject({ status: "succeeded", unitId: "unit-b" });
				expect(artifactA.unitFingerprint).not.toBe(artifactB.unitFingerprint);
			},
		);
	});

	test("source changes during a PASS review produce a terminal stale_sources artifact", async () => {
		await withTempWorkspace(
			{ "source.ts": "export const value = 1;\n", "related.ts": "export const dependency = 1;\n" },
			async context => {
				const sourcePath = context.paths["source.ts"]!;
				const relatedPath = context.paths["related.ts"]!;
				const planner: PromptRunner = async ({ resultSchema, stage }) =>
					promptResult(resultSchema, stage, {
						overview: "Single unit",
						units: plannerUnits([{ id: "source", filePath: sourcePath, relatedFiles: [relatedPath] }]),
					});
				const { plan } = await createValidatedPlan({
					cwd: context.cwd,
					roots: context.roots,
					targetFiles: [sourcePath],
					reviewGoal: "Review source",
					sourceLoader: context.sourceLoader,
					clock: context.clock,
					runPrompt: planner,
				});
				const reviewer: PromptRunner = async ({ resultSchema, stage }) => {
					await Bun.write(relatedPath, "export const dependency = 2;\n");
					return promptResult(resultSchema, stage, passReview("source", sourcePath), [sourcePath]);
				};

				const artifact = await reviewUnit(
					{ plan, unitId: "source", cwd: context.cwd, roots: context.roots },
					{ runPrompt: reviewer, sourceLoader: context.sourceLoader, hash, thinkingLevel: THINKING },
				);

				expect(artifact).toMatchObject({
					status: "failed",
					unitId: "source",
					failure: { kind: "invalid_unit_result", reason: "stale_sources" },
				});
			},
		);
	});
});

describe("reviewUnits", () => {
	test("selected subset executes only requested ids and preserves identity/order", async () => {
		await withTempWorkspace(
			{
				"a.ts": "export const a = 1;\n",
				"b.ts": "export const b = 2;\n",
				"c.ts": "export const c = 3;\n",
			},
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const planner: PromptRunner = async ({ resultSchema, stage }) =>
					promptResult(resultSchema, stage, {
						overview: "Three units",
						units: plannerUnits([
							{ id: "unit-a", filePath: paths["a.ts"]! },
							{ id: "unit-b", filePath: paths["b.ts"]! },
							{ id: "unit-c", filePath: paths["c.ts"]! },
						]),
					});
				const { plan } = await createValidatedPlan({
					cwd,
					roots,
					targetFiles: [paths["a.ts"]!, paths["b.ts"]!, paths["c.ts"]!],
					reviewGoal: "Review modules",
					sourceLoader,
					clock,
					runPrompt: planner,
				});

				const reviewed: string[] = [];
				const runPrompt: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
					expect(stage).toBe("reviewer");
					const unitId = reviewerUnitId(userPrompt);
					reviewed.push(unitId);
					const filePath =
						unitId === "unit-c" ? paths["c.ts"]! : unitId === "unit-a" ? paths["a.ts"]! : paths["b.ts"]!;
					return promptResult(resultSchema, stage, passReview(unitId, filePath), [filePath]);
				};

				const outcome = await reviewUnits(
					{ plan, unitIds: ["unit-c", "unit-a"], cwd, roots },
					{ runPrompt, sourceLoader, hash, concurrency: 2, thinkingLevel: THINKING },
				);

				expect(outcome.ok).toBe(true);
				if (!outcome.ok) {
					throw new Error(outcome.failure.message);
				}
				expect(outcome.value.map(artifact => artifact.unitId)).toEqual(["unit-c", "unit-a"]);
				expect(new Set(reviewed)).toEqual(new Set(["unit-c", "unit-a"]));
				expect(reviewed).toHaveLength(2);
				expect(outcome.value.every(artifact => artifact.status === "succeeded")).toBe(true);
			},
		);
	});

	test("rejects unknown and duplicate selected unit ids", async () => {
		await withTempWorkspace(
			{
				"a.ts": "export const a = 1;\n",
				"b.ts": "export const b = 2;\n",
			},
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const planner: PromptRunner = async ({ resultSchema, stage }) =>
					promptResult(resultSchema, stage, {
						overview: "Two units",
						units: plannerUnits([
							{ id: "unit-a", filePath: paths["a.ts"]! },
							{ id: "unit-b", filePath: paths["b.ts"]! },
						]),
					});
				const { plan } = await createValidatedPlan({
					cwd,
					roots,
					targetFiles: [paths["a.ts"]!, paths["b.ts"]!],
					reviewGoal: "Review modules",
					sourceLoader,
					clock,
					runPrompt: planner,
				});

				const runPrompt: PromptRunner = async () => {
					throw new Error("reviewer should not run for invalid selection");
				};

				const unknown = await reviewUnits(
					{ plan, unitIds: ["unit-a", "missing"], cwd, roots },
					{ runPrompt, sourceLoader, hash, concurrency: 2, thinkingLevel: THINKING },
				);
				expect(unknown).toEqual({
					ok: false,
					failure: {
						kind: "invalid_unit_result",
						reason: "unknown_unit",
						unitId: "missing",
						message: "Unknown unit id selected: missing",
					},
				});

				const duplicates = await reviewUnits(
					{ plan, unitIds: ["unit-a", "unit-a"], cwd, roots },
					{ runPrompt, sourceLoader, hash, concurrency: 2, thinkingLevel: THINKING },
				);
				expect(duplicates).toEqual({
					ok: false,
					failure: {
						kind: "invalid_unit_result",
						reason: "duplicate_unit",
						unitId: "unit-a",
						message: "Duplicate unit id selected: unit-a",
					},
				});
			},
		);
	});

	test("enforces bounded concurrency with Promise.withResolvers and no sleeps", async () => {
		const fileEntries = Object.fromEntries(
			Array.from({ length: 6 }, (_, index) => [`file-${index}.ts`, `export const v${index} = ${index};\n`]),
		);
		await withTempWorkspace(fileEntries, async ({ cwd, paths, roots, sourceLoader, clock }) => {
			const units = Object.entries(paths).map(([name, filePath], index) => ({
				id: `unit-${index}`,
				filePath,
				title: name,
			}));
			const planner: PromptRunner = async ({ resultSchema, stage }) =>
				promptResult(resultSchema, stage, {
					overview: "Many units",
					units: plannerUnits(units),
				});
			const { plan } = await createValidatedPlan({
				cwd,
				roots,
				targetFiles: Object.values(paths),
				reviewGoal: "Review modules",
				sourceLoader,
				clock,
				runPrompt: planner,
			});

			const concurrency = 2;
			let active = 0;
			let maximumActive = 0;
			const releaseGate = Promise.withResolvers<void>();

			const runPrompt: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
				expect(stage).toBe("reviewer");
				const unitId = reviewerUnitId(userPrompt);
				const unit = units.find(candidate => candidate.id === unitId);
				if (!unit) {
					throw new Error(`Unknown unit ${unitId}`);
				}

				active += 1;
				maximumActive = Math.max(maximumActive, active);
				if (active === concurrency) {
					releaseGate.resolve();
				}
				await releaseGate.promise;
				active -= 1;

				return promptResult(resultSchema, stage, passReview(unitId, unit.filePath), [unit.filePath]);
			};

			const outcome = await reviewUnits(
				{ plan, unitIds: plan.units.map(unit => unit.id), cwd, roots },
				{ runPrompt, sourceLoader, hash, concurrency, thinkingLevel: THINKING },
			);

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) {
				throw new Error(outcome.failure.message);
			}
			expect(maximumActive).toBe(concurrency);
			expect(outcome.value).toHaveLength(units.length);
			expect(outcome.value.every(artifact => artifact.status === "succeeded")).toBe(true);
		});
	});
});

describe("aggregateReview", () => {
	async function twoUnitFixture(
		run: (fixture: {
			cwd: string;
			roots: string[];
			paths: Record<string, string>;
			contents: Record<string, string>;
			sourceLoader: SourceLoader;
			clock: Clock & { advance(ms: number): void };
			plan: ValidatedPlan;
			succeeded: UnitReviewArtifact[];
			failedEvidence: UnitReviewArtifact;
		}) => Promise<void>,
	) {
		const contents = {
			"a.ts": "export function divide(a: number, b: number) {\n\treturn a / b;\n}\n",
			"b.ts": "export const format = (value: number) => String(value);\n",
		};
		await withTempWorkspace(contents, async ({ cwd, paths, roots, sourceLoader, clock }) => {
			const planner: PromptRunner = async ({ resultSchema, stage }) =>
				promptResult(resultSchema, stage, {
					overview: "Numeric surface",
					units: plannerUnits([
						{ id: "division", filePath: paths["a.ts"]!, riskLevel: "high", reviewFocus: ["zero divisor"] },
						{ id: "formatting", filePath: paths["b.ts"]!, riskLevel: "low", reviewFocus: ["output contract"] },
					]),
				});
			const { plan } = await createValidatedPlan({
				cwd,
				roots,
				targetFiles: [paths["a.ts"]!, paths["b.ts"]!],
				reviewGoal: "Review public numeric behavior",
				riskLevel: "high",
				sourceLoader,
				clock,
				runPrompt: planner,
			});

			const successRunner: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
				const unitId = reviewerUnitId(userPrompt);
				if (unitId === "division") {
					return promptResult(
						resultSchema,
						stage,
						findingReview({
							unitId,
							filePath: paths["a.ts"]!,
							fileContent: contents["a.ts"],
							findingId: "zero-divisor",
							severity: "critical",
							startLine: 2,
							title: "Division by zero is unchecked",
						}),
						[paths["a.ts"]!],
					);
				}
				return promptResult(
					resultSchema,
					stage,
					findingReview({
						unitId,
						filePath: paths["b.ts"]!,
						fileContent: contents["b.ts"],
						findingId: "string-coercion",
						severity: "minor",
						startLine: 1,
						title: "Format always stringifies",
					}),
					[paths["b.ts"]!],
				);
			};

			const succeededOutcome = await reviewUnits(
				{ plan, unitIds: ["division", "formatting"], cwd, roots },
				{ runPrompt: successRunner, sourceLoader, hash, concurrency: 2, thinkingLevel: THINKING },
			);
			expect(succeededOutcome.ok).toBe(true);
			if (!succeededOutcome.ok) {
				throw new Error(succeededOutcome.failure.message);
			}

			const failedEvidence = await reviewUnit(
				{ plan, unitId: "formatting", cwd, roots },
				{
					runPrompt: async ({ resultSchema, stage }) =>
						promptResult(
							resultSchema,
							stage,
							{
								unit_id: "formatting",
								verdict: "FAIL",
								summary: "Bad evidence",
								findings: [
									{
										id: "bad",
										title: "Bad",
										category: "correctness",
										severity: "major",
										confidence: "high",
										evidence: [
											{
												source_id: paths["b.ts"]!,
												start_line: 1,
												end_line: 1,
												quote: "not the real source",
												observation: "Fabricated",
											},
										],
										reason: "Fabricated",
										suggested_action: "None",
										verification_after_change: "Re-read",
									},
								],
								coverage: [{ path: paths["b.ts"]!, status: "reviewed", notes: "Read" }],
							},
							[paths["b.ts"]!],
						),
					sourceLoader,
					hash,
					thinkingLevel: THINKING,
				},
			);
			expect(failedEvidence.status).toBe("failed");

			await run({
				cwd,
				roots,
				paths,
				contents,
				sourceLoader,
				clock,
				plan,
				succeeded: succeededOutcome.value,
				failedEvidence,
			});
		});
	}

	test("rejects complete artifacts when unit sources changed after review", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, sourceLoader, clock, paths }) => {
			await Bun.write(paths["a.ts"]!, "export const divide = () => 0;\n");
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ stage }) => {
				if (stage === "aggregator") aggregatorCalls += 1;
				throw new Error(`Unexpected stage ${stage}`);
			};

			const outcome = await aggregateReview(
				{ plan, unitReviews: succeeded, cwd, startedAt: clock.now() },
				{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);

			expect(aggregatorCalls).toBe(0);
			expect(outcome).toMatchObject({
				ok: false,
				failure: { kind: "invalid_unit_result", reason: "stale_sources", unitId: "division" },
			});
		});
	});

	test("rejects artifacts when sources change while aggregation is running", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, sourceLoader, clock, paths }) => {
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ resultSchema, stage }) => {
				aggregatorCalls += 1;
				await Bun.write(paths["b.ts"]!, "export const format = () => 'changed';\n");
				return promptResult(resultSchema, stage, {
					overall_summary: "Review completed",
					ordered_groups: [
						{
							finding_refs: [
								{ unit_id: "division", finding_id: "zero-divisor" },
								{ unit_id: "formatting", finding_id: "string-coercion" },
							],
							title: "Numeric API contracts",
							reason: "Grouped public API issues",
							recommended_action: "Tighten API contracts",
							verification_after_change: "Cover numeric edges",
						},
					],
					coverage_gaps: [],
				});
			};

			const outcome = await aggregateReview(
				{ plan, unitReviews: succeeded, cwd, startedAt: clock.now() },
				{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);

			expect(aggregatorCalls).toBe(1);
			expect(outcome).toMatchObject({
				ok: false,
				failure: { kind: "invalid_unit_result", reason: "stale_sources", unitId: "formatting" },
			});
		});
	});

	test("premature missing results are a typed failure and do not invoke the aggregator", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, sourceLoader, clock }) => {
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ stage }) => {
				if (stage === "aggregator") {
					aggregatorCalls += 1;
				}
				throw new Error(`Unexpected stage ${stage}`);
			};

			const outcome = await aggregateReview(
				{
					plan,
					unitReviews: [succeeded[0]!],
					cwd,
					startedAt: clock.now(),
				},
				{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);

			expect(aggregatorCalls).toBe(0);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) {
				throw new Error("expected missing_results failure");
			}
			expect(outcome.failure).toMatchObject({
				kind: "invalid_aggregation",
				reason: "missing_results",
			});
		});
	});

	test("failed terminal unit results still aggregate with coverage gaps", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, failedEvidence, sourceLoader, clock, paths }) => {
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ resultSchema, stage }) => {
				expect(stage).toBe("aggregator");
				aggregatorCalls += 1;
				return promptResult(resultSchema, stage, {
					overall_summary: "Formatting review failed validation",
					ordered_groups: [
						{
							finding_refs: [{ unit_id: "division", finding_id: "zero-divisor" }],
							title: "Define division by zero behavior",
							reason: "Numeric API has no zero-divisor contract",
							recommended_action: "Reject zero or return an explicit domain result",
							verification_after_change: "Assert the selected zero-divisor behavior",
						},
					],
					coverage_gaps: [],
				});
			};

			const outcome = await aggregateReview(
				{
					plan,
					unitReviews: [succeeded[0]!, failedEvidence],
					cwd,
					startedAt: clock.now(),
				},
				{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);

			expect(aggregatorCalls).toBe(1);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) {
				throw new Error(outcome.failure.message);
			}
			expect(outcome.value.incomplete).toBe(true);
			expect(outcome.value.aggregate.verdict).toBe("INSUFFICIENT_CONTEXT");
			expect(outcome.value.coverageGaps).toEqual([
				{
					unitId: "formatting",
					path: paths["b.ts"],
					reason: failedEvidence.status === "failed" ? failedEvidence.failure.message : "",
				},
			]);
			expect(outcome.value.findings).toHaveLength(1);
		});
	});

	test("complete results invoke the aggregator once, conserve findings, and keep deterministic severity", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, sourceLoader, clock }) => {
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ resultSchema, stage }) => {
				expect(stage).toBe("aggregator");
				aggregatorCalls += 1;
				return promptResult(resultSchema, stage, {
					overall_summary: "Critical division defect dominates",
					ordered_groups: [
						{
							finding_refs: [
								{ unit_id: "division", finding_id: "zero-divisor" },
								{ unit_id: "formatting", finding_id: "string-coercion" },
							],
							title: "Numeric API contracts",
							reason: "Grouped related public API issues",
							recommended_action: "Tighten division and formatting contracts",
							verification_after_change: "Cover zero and formatting edges",
						},
					],
					coverage_gaps: [],
				});
			};

			const outcome = await aggregateReview(
				{
					plan,
					unitReviews: succeeded,
					cwd,
					startedAt: clock.now(),
				},
				{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);

			expect(aggregatorCalls).toBe(1);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) {
				throw new Error(outcome.failure.message);
			}

			expect(outcome.value.incomplete).toBe(false);
			expect(outcome.value.aggregate.verdict).toBe("FAIL");
			expect(outcome.value.findings).toHaveLength(1);
			expect(outcome.value.findings[0]).toMatchObject({
				sourceFindings: ["division/zero-divisor", "formatting/string-coercion"],
				severity: "critical",
				confidence: "high",
			});
			expect(outcome.value.aggregate.counts.findingCount).toBe(1);
			expect(outcome.value.aggregate.counts.countsBySeverity.critical).toBe(1);
			expect(outcome.value.aggregate.counts.countsBySeverity.minor).toBe(0);
		});
	});

	test("foreign, stale, duplicate, and unknown unit artifacts fail before the aggregator runs", async () => {
		await twoUnitFixture(async ({ cwd, plan, succeeded, sourceLoader, clock }) => {
			let aggregatorCalls = 0;
			const runPrompt: PromptRunner = async ({ stage }) => {
				if (stage === "aggregator") {
					aggregatorCalls += 1;
				}
				throw new Error(`Unexpected stage ${stage}`);
			};

			const [division, formatting] = succeeded;
			if (!division || !formatting) {
				throw new Error("expected two succeeded artifacts");
			}

			const cases: Array<{ label: string; unitReviews: UnitReviewArtifact[]; reason: string }> = [
				{
					label: "foreign",
					unitReviews: [{ ...division, planFingerprint: "f".repeat(64) }, formatting],
					reason: "foreign_plan",
				},
				{
					label: "stale",
					unitReviews: [{ ...division, unitFingerprint: "s".repeat(64) }, formatting],
					reason: "stale_unit",
				},
				{
					label: "duplicate",
					unitReviews: [division, { ...division, unitId: "division" }],
					reason: "duplicate_unit",
				},
				{
					label: "unknown",
					unitReviews: [division, { ...formatting, unitId: "ghost-unit" }],
					reason: "unknown_unit",
				},
			];

			for (const testCase of cases) {
				aggregatorCalls = 0;
				const outcome = await aggregateReview(
					{
						plan,
						unitReviews: testCase.unitReviews,
						cwd,
						startedAt: clock.now(),
					},
					{ runPrompt, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
				);
				expect(aggregatorCalls, testCase.label).toBe(0);
				expect(outcome.ok, testCase.label).toBe(false);
				if (outcome.ok) {
					throw new Error(`expected ${testCase.label} failure`);
				}
				expect(outcome.failure).toMatchObject({
					kind: "invalid_unit_result",
					reason: testCase.reason,
				});
			}
		});
	});
});

describe("end-to-end lifecycle smoke", () => {
	test("create, edit, review, aggregate, and match runReview report contract", async () => {
		const contents = {
			"divide.ts": "export function divide(a: number, b: number) {\n\treturn a / b;\n}\n",
			"format.ts": "export const format = (value: number) => String(value);\n",
		};

		await withTempWorkspace(contents, async ({ cwd, paths, roots, sourceLoader, clock }) => {
			const dividePath = paths["divide.ts"]!;
			const formatPath = paths["format.ts"]!;
			const editedFocus = ["zero divisor", "domain errors"];

			const buildPlannerOutput = (focus: string[]) => ({
				overview: "Two independent behaviors",
				units: plannerUnits([
					{
						id: "division",
						filePath: dividePath,
						riskLevel: "high",
						reviewFocus: focus,
						title: "Division",
					},
					{
						id: "formatting",
						filePath: formatPath,
						riskLevel: "low",
						reviewFocus: ["output contract"],
						title: "Formatting",
					},
				]),
			});

			const buildReviewerOutput = (unitId: string) => {
				if (unitId === "division") {
					return {
						value: findingReview({
							unitId,
							filePath: dividePath,
							fileContent: contents["divide.ts"],
							findingId: "zero-divisor",
							severity: "major",
							startLine: 2,
							title: "Division by zero is unchecked",
						}),
						reads: [dividePath],
					};
				}
				return {
					value: passReview(unitId, formatPath),
					reads: [formatPath],
				};
			};

			const buildAggregatorOutput = () => ({
				overall_summary: "One correctness defect",
				ordered_groups: [
					{
						finding_refs: [{ unit_id: "division", finding_id: "zero-divisor" }],
						title: "Define division by zero behavior",
						reason: "The numeric API has no zero-divisor contract",
						recommended_action: "Reject zero or return an explicit domain result",
						verification_after_change: "Assert the selected zero-divisor behavior",
					},
				],
				coverage_gaps: [],
			});

			const stages: PromptStage[] = [];
			const createPlanRunner: PromptRunner = async ({ resultSchema, stage }) => {
				stages.push(stage);
				expect(stage).toBe("planner");
				return promptResult(resultSchema, stage, buildPlannerOutput(["zero divisor"]));
			};

			const created = await createReviewPlan(
				{
					reviewGoal: "Review public numeric behavior",
					riskLevel: "high",
					targetFiles: [dividePath, formatPath],
					cwd,
					roots,
				},
				{ runPrompt: createPlanRunner, sourceLoader, clock, hash, thinkingLevel: THINKING },
			);
			expect(created.ok).toBe(true);
			if (!created.ok) {
				throw new Error(created.failure.message);
			}
			expect(stages).toEqual(["planner"]);

			const artifactDir = path.join(cwd, "artifacts");
			const planPath = path.join(artifactDir, "plan.json");
			await writeJsonAtomic(planPath, created.value);

			const editable = JSON.parse(await fs.readFile(planPath, "utf8")) as PlanArtifact;
			const divisionUnit = editable.units.find(unit => unit.id === "division");
			expect(divisionUnit).toBeDefined();
			divisionUnit!.reviewFocus = editedFocus;
			await writeJsonAtomic(planPath, editable);

			const loadedUnknown: unknown = JSON.parse(await fs.readFile(planPath, "utf8"));
			const validated = parsePlanArtifact(loadedUnknown, {
				cwd,
				roots: [...roots],
				targetFiles: [dividePath, formatPath],
				sourceFingerprint: created.value.sourceFingerprint,
				hash,
			});
			expect(validated.ok).toBe(true);
			if (!validated.ok) {
				throw new Error(validated.failure.message);
			}
			expect(validated.value.units.find(unit => unit.id === "division")?.reviewFocus).toEqual(editedFocus);

			const stagedReviewerCalls: string[] = [];
			const stagedRunner: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
				if (stage === "reviewer") {
					const unitId = reviewerUnitId(userPrompt);
					stagedReviewerCalls.push(unitId);
					const review = buildReviewerOutput(unitId);
					return promptResult(resultSchema, stage, review.value, review.reads);
				}
				if (stage === "aggregator") {
					return promptResult(resultSchema, stage, buildAggregatorOutput());
				}
				throw new Error(`Unexpected staged stage ${stage}`);
			};

			const first = await reviewUnit(
				{ plan: validated.value, unitId: "division", cwd, roots },
				{ runPrompt: stagedRunner, sourceLoader, hash, thinkingLevel: THINKING },
			);
			expect(first).toMatchObject({ status: "succeeded", unitId: "division" });
			if (first.status === "succeeded") {
				expect(first.review.findings[0]?.evidence[0]).toMatchObject({
					sourceId: dividePath,
					startLine: 2,
					endLine: 2,
					quote: "\treturn a / b;",
				});
				expect(first.review.findings[0]?.evidence[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
			}

			let prematureAggregatorCalls = 0;
			const premature = await aggregateReview(
				{
					plan: validated.value,
					unitReviews: [first],
					cwd,
					startedAt: clock.now(),
				},
				{
					runPrompt: async ({ stage }) => {
						if (stage === "aggregator") {
							prematureAggregatorCalls += 1;
						}
						throw new Error(`Unexpected stage ${stage}`);
					},
					sourceLoader,
					hash,
					clock,
					modelId: MODEL_ID,
					thinkingLevel: THINKING,
				},
			);
			expect(prematureAggregatorCalls).toBe(0);
			expect(premature.ok).toBe(false);
			if (premature.ok) {
				throw new Error("expected premature aggregation failure");
			}
			expect(premature.failure).toMatchObject({
				kind: "invalid_aggregation",
				reason: "missing_results",
			});

			const remaining = await reviewUnits(
				{ plan: validated.value, unitIds: ["formatting"], cwd, roots },
				{ runPrompt: stagedRunner, sourceLoader, hash, concurrency: 2, thinkingLevel: THINKING },
			);
			expect(remaining.ok).toBe(true);
			if (!remaining.ok) {
				throw new Error(remaining.failure.message);
			}
			expect(stagedReviewerCalls).toEqual(["division", "formatting"]);

			const unitArtifacts = [first, ...remaining.value];
			for (const artifact of unitArtifacts) {
				await writeJsonAtomic(path.join(artifactDir, `${artifact.unitId}.json`), artifact);
			}

			clock.advance(25);
			const startedAt = clock.now();
			clock.advance(40);
			const aggregated = await aggregateReview(
				{
					plan: validated.value,
					unitReviews: unitArtifacts,
					cwd,
					startedAt,
				},
				{ runPrompt: stagedRunner, sourceLoader, hash, clock, modelId: MODEL_ID, thinkingLevel: THINKING },
			);
			expect(aggregated.ok).toBe(true);
			if (!aggregated.ok) {
				throw new Error(aggregated.failure.message);
			}

			const reportPath = path.join(artifactDir, "report.json");
			await writeJsonAtomic(reportPath, aggregated.value);
			const persistedReport = JSON.parse(await fs.readFile(reportPath, "utf8")) as ReviewReport;
			expect(persistedReport.aggregate.verdict).toBe("FAIL");
			expect(persistedReport.findings[0]).toMatchObject({
				severity: "major",
				sourceFindings: ["division/zero-divisor"],
			});
			expect(persistedReport.incomplete).toBe(false);

			const runReviewRunner: PromptRunner = async ({ resultSchema, stage, userPrompt }) => {
				if (stage === "planner") {
					return promptResult(resultSchema, stage, buildPlannerOutput(editedFocus));
				}
				if (stage === "reviewer") {
					const unitId = reviewerUnitId(userPrompt);
					const review = buildReviewerOutput(unitId);
					return promptResult(resultSchema, stage, review.value, review.reads);
				}
				if (stage === "aggregator") {
					return promptResult(resultSchema, stage, buildAggregatorOutput());
				}
				throw new Error(`Unexpected runReview stage ${stage}`);
			};

			clock.advance(10);
			const runReviewStartedClock = createClock(clock.now());
			const full = await runReview(
				{
					reviewGoal: "Review public numeric behavior",
					riskLevel: "high",
					targetFiles: [dividePath, formatPath],
					cwd,
					roots,
				},
				{
					runPrompt: runReviewRunner,
					sourceLoader,
					clock: runReviewStartedClock,
					hash,
					concurrency: 2,
					modelId: MODEL_ID,
					thinkingLevel: THINKING,
				},
			);
			expect(full.ok).toBe(true);
			if (!full.ok) {
				throw new Error(full.failure.message);
			}

			expect(reportContract(full.value)).toEqual(reportContract(aggregated.value));
		});
	});
});

describe("hierarchical guide prompt delivery", () => {
	test("routes metadata to planner, selected documents to reviewer, and no documents to aggregator", async () => {
		await withTempWorkspace(
			{ "source.ts": "export const value = 1;\n" },
			async ({ cwd, paths, roots, sourceLoader, clock }) => {
				const captured: Partial<Record<PromptStage, { systemPrompt: string; userPrompt: string }>> = {};
				const runPrompt: PromptRunner = async ({ resultSchema, stage, systemPrompt, userPrompt }) => {
					captured[stage] = { systemPrompt, userPrompt };
					if (stage === "planner") {
						return promptResult(resultSchema, stage, {
							overview: "One selected review unit",
							units: plannerUnits([
								{
									id: "source",
									filePath: paths["source.ts"]!,
									guideIds: ["contract/errors-handling", "narrative/readability"],
									reviewFocus: ["public error result", "entry-point contract"],
								},
							]),
						});
					}
					if (stage === "reviewer") {
						return promptResult(resultSchema, stage, passReview("source", paths["source.ts"]!), [
							paths["source.ts"]!,
						]);
					}
					return promptResult(resultSchema, stage, {
						overall_summary: "No findings",
						ordered_groups: [],
						coverage_gaps: [],
					});
				};

				const result = await runReview(
					{
						reviewGoal: "Review exported value",
						riskLevel: "medium",
						targetFiles: [paths["source.ts"]!],
						cwd,
						roots,
					},
					{
						runPrompt,
						sourceLoader,
						clock,
						hash,
						concurrency: 1,
						modelId: MODEL_ID,
						thinkingLevel: THINKING,
					},
				);
				expect(result.ok).toBe(true);

				expect(captured.planner?.userPrompt).toContain('"guide_catalog"');
				expect(captured.planner?.userPrompt).toContain('"contract/errors-handling"');
				expect(captured.planner?.userPrompt).not.toContain("### ERROR-01 —");

				expect(captured.reviewer?.systemPrompt).toContain("# Core review contract");
				expect(captured.reviewer?.systemPrompt).toContain("### ERROR-01 —");
				expect(captured.reviewer?.systemPrompt).toContain("### LANG-1 —");
				expect(captured.reviewer?.systemPrompt).not.toContain("### STATE-01 —");
				expect(captured.reviewer?.userPrompt).toContain(
					'"guide_ids": [\n      "contract/errors-handling",\n      "narrative/readability"',
				);

				expect(captured.aggregator?.systemPrompt).not.toContain("# Core review contract");
				expect(captured.aggregator?.userPrompt).not.toContain("### ERROR-01 —");
				expect(captured.aggregator?.userPrompt).not.toContain("### LANG-1 —");
			},
		);
	});
});

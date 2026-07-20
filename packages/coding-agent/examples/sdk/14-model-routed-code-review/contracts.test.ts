import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parsePlanArtifact,
	parsePlannerOutput,
	parseReviewerOutput,
	parseUnitReviewArtifact,
	toPlanArtifact,
	toValidatedPlan,
} from "./artifact-codec";
import { parseCliCommand } from "./cli";
import {
	type HashFn,
	type PlanArtifact,
	type PromptExecutionMetadata,
	type ReviewFailure,
	type ReviewOutcome,
	type ReviewUnit,
	UNIT_REVIEW_SCHEMA_VERSION,
	type UnitReviewArtifact,
	type ValidatedPlan,
} from "./contracts";

const hash: HashFn = canonical => createHash("sha256").update(canonical).digest("hex");

const emptyUsage = {
	input: 1,
	output: 1,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
};

function plannerExecution(overrides: Partial<PromptExecutionMetadata> = {}): PromptExecutionMetadata {
	return {
		stage: "planner",
		durationMs: overrides.durationMs ?? 10,
		tokenUsage: { ...emptyUsage, ...(overrides.tokenUsage ?? {}) },
		contextTools: {
			enabled: true,
			maxCalls: 24,
			requestedCalls: 0,
			blockedCalls: 0,
			callsByTool: {},
			...(overrides.contextTools ?? {}),
		},
	};
}

function expectFailure(
	outcome: ReviewOutcome<unknown>,
	expected: Pick<Extract<ReviewFailure, { reason: string }>, "kind" | "reason">,
): asserts outcome is { ok: false; failure: ReviewFailure } {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) return;
	expect(outcome.failure.kind).toBe(expected.kind);
	expect(outcome.failure).toEqual(expect.objectContaining({ reason: expected.reason }));
}

function expectFailureKind(outcome: ReviewOutcome<unknown>, kind: ReviewFailure["kind"]): void {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) return;
	expect(outcome.failure.kind).toBe(kind);
}

async function withTempRoot(
	run: (paths: { root: string; a: string; b: string; outside: string }) => Promise<void> | void,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "contracts-boundary-"));
	const a = path.join(root, "a.ts");
	const b = path.join(root, "b.ts");
	const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.ts`);
	try {
		await run({ root, a, b, outside });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function rawPlannerUnit(input: {
	id: string;
	primary: string | string[];
	related?: string[];
	title?: string;
	objective?: string;
	focus?: string[];
	riskLevel?: "low" | "medium" | "high" | "critical";
	rationale?: string;
	guideIds?: string[];
}) {
	return {
		id: input.id,
		title: input.title ?? input.id,
		objective: input.objective ?? `Review ${input.id}`,
		primary_files: Array.isArray(input.primary) ? input.primary : [input.primary],
		related_files: input.related ?? [],
		review_focus: input.focus ?? ["correctness"],
		guide_ids: input.guideIds ?? ["contract/state-lifecycle"],
		risk_level: input.riskLevel ?? "medium",
		rationale: input.rationale ?? `Owns ${input.id}`,
	};
}

function reviewUnit(input: {
	id: string;
	primaryFiles: string[];
	relatedFiles?: string[];
	title?: string;
	objective?: string;
	reviewFocus?: string[];
	riskLevel?: ReviewUnit["riskLevel"];
	guideIds?: ReviewUnit["guideIds"];
	rationale?: string;
}): ReviewUnit {
	return {
		id: input.id,
		title: input.title ?? input.id,
		objective: input.objective ?? `Review ${input.id}`,
		primaryFiles: input.primaryFiles,
		relatedFiles: input.relatedFiles ?? [],
		reviewFocus: input.reviewFocus ?? ["correctness"],
		guideIds: input.guideIds ?? ["contract/state-lifecycle"],
		riskLevel: input.riskLevel ?? "medium",
		rationale: input.rationale ?? `Owns ${input.id}`,
	};
}

function sourceFingerprint(label: string): string {
	return hash(label);
}

function buildPlanArtifact(input: {
	targets: string[];
	units: ReviewUnit[];
	reviewGoal?: string;
	sourceFingerprint?: string;
	createdAt?: string;
	plannerExecution?: PromptExecutionMetadata;
}): PlanArtifact {
	return toPlanArtifact({
		reviewGoal: input.reviewGoal ?? "Review boundary contracts",
		riskLevel: "medium",
		targetFiles: input.targets,
		sourceFingerprint: input.sourceFingerprint ?? sourceFingerprint("sources-v1"),
		units: input.units,
		createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
		plannerExecution: input.plannerExecution ?? plannerExecution(),
	});
}

function parseTrustedPlan(
	artifact: PlanArtifact,
	root: string,
	targets: string[],
	fingerprint = artifact.sourceFingerprint,
) {
	return parsePlanArtifact(artifact, {
		cwd: root,
		roots: [root],
		targetFiles: targets,
		sourceFingerprint: fingerprint,
		hash,
	});
}

function succeededUnitArtifact(
	plan: ValidatedPlan,
	unitId: string,
): Extract<UnitReviewArtifact, { status: "succeeded" }> {
	const unit = plan.units.find(item => item.id === unitId);
	if (!unit) throw new Error(`missing unit ${unitId}`);
	return {
		schemaVersion: UNIT_REVIEW_SCHEMA_VERSION,
		planFingerprint: plan.planFingerprint,
		unitId,
		unitFingerprint: unit.unitFingerprint,
		sourceFingerprint: "c".repeat(64),
		status: "succeeded",
		review: {
			unitId,
			verdict: "PASS",
			summary: "No defects",
			findings: [],
			coverage: [{ path: unit.primaryFiles[0]!, status: "reviewed", notes: "Read" }],
		},
		execution: {
			stage: "reviewer",
			durationMs: 1,
			tokenUsage: emptyUsage,
			contextTools: {
				enabled: true,
				maxCalls: 24,
				requestedCalls: 0,
				blockedCalls: 0,
				callsByTool: {},
			},
		},
	};
}

describe("parsePlannerOutput canonical editable semantics", () => {
	test("normalizes planner DTO into absolute editable ReviewUnit semantics", async () => {
		await withTempRoot(({ root, a, b }) => {
			const relativePrimary = path.relative(root, a);
			const outcome = parsePlannerOutput(
				{
					overview: "Canonical plan",
					units: [
						rawPlannerUnit({
							id: "alpha",
							primary: relativePrimary,
							related: [b, b],
							focus: ["ownership", "paths"],
							riskLevel: "high",
						}),
						rawPlannerUnit({ id: "beta", primary: b }),
					],
				},
				{ cwd: root, roots: [root], targetFiles: [a, b] },
			);

			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.value).toEqual({
				overview: "Canonical plan",
				units: [
					{
						id: "alpha",
						title: "alpha",
						objective: "Review alpha",
						primaryFiles: [a],
						relatedFiles: [b],
						reviewFocus: ["ownership", "paths"],
						guideIds: ["contract/state-lifecycle"],
						riskLevel: "high",
						rationale: "Owns alpha",
					},
					{
						id: "beta",
						title: "beta",
						objective: "Review beta",
						primaryFiles: [b],
						relatedFiles: [],
						reviewFocus: ["correctness"],
						guideIds: ["contract/state-lifecycle"],
						riskLevel: "medium",
						rationale: "Owns beta",
					},
				],
			});

			const artifact = buildPlanArtifact({
				targets: [a, b],
				units: outcome.value.units,
			});
			const validated = parseTrustedPlan(artifact, root, [a, b]);
			expect(validated.ok).toBe(true);
			if (!validated.ok) return;
			expect(validated.value.units.map(unit => unit.id)).toEqual(["alpha", "beta"]);
			expect(validated.value.planFingerprint).toHaveLength(64);
		});
	});

	test("preserves selected guide priority order", async () => {
		await withTempRoot(({ root, a }) => {
			const outcome = parsePlannerOutput(
				{
					overview: "Ordered guides",
					units: [
						rawPlannerUnit({
							id: "alpha",
							primary: a,
							guideIds: ["narrative/readability", "contract/errors-handling"],
						}),
					],
				},
				{ cwd: root, roots: [root], targetFiles: [a] },
			);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.value.units[0]?.guideIds).toEqual(["narrative/readability", "contract/errors-handling"]);
		});
	});

	test("rejects invalid guide selections with typed failures", async () => {
		await withTempRoot(({ root, a }) => {
			for (const guideIds of [
				[],
				["unknown/guide"],
				["contract/state-lifecycle", "contract/state-lifecycle"],
				[
					"contract/state-lifecycle",
					"contract/errors-handling",
					"contract/policy-ownership",
					"narrative/readability",
				],
				["core"],
			]) {
				const outcome = parsePlannerOutput(
					{
						overview: "Invalid guides",
						units: [rawPlannerUnit({ id: "alpha", primary: a, guideIds })],
					},
					{ cwd: root, roots: [root], targetFiles: [a] },
				);
				expectFailure(outcome, { kind: "invalid_plan", reason: "guide_selection" });
			}
		});
	});

	test("rejects legacy planner output without guide_ids", async () => {
		await withTempRoot(({ root, a }) => {
			const { guide_ids: omittedGuideIds, ...legacyUnit } = rawPlannerUnit({ id: "alpha", primary: a });
			expect(omittedGuideIds).toEqual(["contract/state-lifecycle"]);
			const outcome = parsePlannerOutput(
				{ overview: "Legacy plan", units: [legacyUnit] },
				{ cwd: root, roots: [root], targetFiles: [a] },
			);
			expectFailure(outcome, { kind: "invalid_plan", reason: "schema" });
		});
	});
});

describe("parsePlanArtifact editable plan contracts", () => {
	test("accepts valid human edits while enforcing exact one primary owner per target", async () => {
		await withTempRoot(({ root, a, b }) => {
			const artifact = buildPlanArtifact({
				targets: [a, b],
				units: [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })],
			});

			const edited: PlanArtifact = {
				...artifact,
				reviewGoal: "Human-edited review goal",
				units: [
					{ ...artifact.units[0]!, title: "Alpha edited", objective: "Edited objective" },
					artifact.units[1]!,
				],
			};

			const accepted = parseTrustedPlan(edited, root, [a, b]);
			expect(accepted.ok).toBe(true);
			if (!accepted.ok) return;
			expect(accepted.value.reviewGoal).toBe("Human-edited review goal");
			expect(accepted.value.units[0]?.title).toBe("Alpha edited");

			expectFailure(parseTrustedPlan({ ...artifact, units: [artifact.units[0]!] }, root, [a, b]), {
				kind: "invalid_plan",
				reason: "ownership",
			});

			expectFailure(
				parseTrustedPlan(
					{
						...artifact,
						units: [artifact.units[0]!, { ...artifact.units[1]!, primaryFiles: [a, b] }],
					},
					root,
					[a, b],
				),
				{ kind: "invalid_plan", reason: "ownership" },
			);
		});
	});

	test("duplicate unit ids fail as invalid_plan duplicate_unit", async () => {
		await withTempRoot(({ root, a, b }) => {
			const artifact = buildPlanArtifact({
				targets: [a, b],
				units: [reviewUnit({ id: "same", primaryFiles: [a] }), reviewUnit({ id: "same", primaryFiles: [b] })],
			});
			expectFailure(parseTrustedPlan(artifact, root, [a, b]), {
				kind: "invalid_plan",
				reason: "duplicate_unit",
			});

			expectFailure(
				parsePlannerOutput(
					{
						overview: "Duplicate ids",
						units: [rawPlannerUnit({ id: "same", primary: a }), rawPlannerUnit({ id: "same", primary: b })],
					},
					{ cwd: root, roots: [root], targetFiles: [a, b] },
				),
				{ kind: "invalid_plan", reason: "duplicate_unit" },
			);
		});
	});

	test("malformed edits fail as invalid_plan schema path or ownership", async () => {
		await withTempRoot(({ root, a, b, outside }) => {
			const artifact = buildPlanArtifact({
				targets: [a, b],
				units: [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })],
			});

			expectFailure(parseTrustedPlan({ ...artifact, reviewGoal: "" }, root, [a, b]), {
				kind: "invalid_plan",
				reason: "schema",
			});

			expectFailure(
				parseTrustedPlan(
					{
						...artifact,
						units: [{ ...artifact.units[0]!, primaryFiles: [a, a] }, artifact.units[1]!],
					},
					root,
					[a, b],
				),
				{ kind: "invalid_plan", reason: "path" },
			);

			expectFailure(
				parseTrustedPlan(
					{
						...artifact,
						units: [{ ...artifact.units[0]!, relatedFiles: [outside] }, artifact.units[1]!],
					},
					root,
					[a, b],
				),
				{ kind: "invalid_plan", reason: "path" },
			);

			expectFailure(parseTrustedPlan({ ...artifact, units: [artifact.units[0]!] }, root, [a, b]), {
				kind: "invalid_plan",
				reason: "ownership",
			});
		});
	});

	test("editable guide selection failures use guide_selection while legacy plans fail schema", async () => {
		await withTempRoot(({ root, a }) => {
			const artifact = buildPlanArtifact({
				targets: [a],
				units: [reviewUnit({ id: "alpha", primaryFiles: [a] })],
			});
			for (const guideIds of [
				[],
				["unknown/guide"],
				["contract/state-lifecycle", "contract/state-lifecycle"],
				[
					"contract/state-lifecycle",
					"contract/errors-handling",
					"contract/policy-ownership",
					"narrative/readability",
				],
				["core"],
			]) {
				expectFailure(
					parsePlanArtifact(
						{ ...artifact, units: [{ ...artifact.units[0]!, guideIds }] },
						{
							cwd: root,
							roots: [root],
							targetFiles: [a],
							sourceFingerprint: artifact.sourceFingerprint,
							hash,
						},
					),
					{ kind: "invalid_plan", reason: "guide_selection" },
				);
			}

			const { guideIds: omittedGuideIds, ...legacyUnit } = artifact.units[0]!;
			expect(omittedGuideIds).toEqual(["contract/state-lifecycle"]);
			expectFailure(
				parsePlanArtifact(
					{ ...artifact, units: [legacyUnit] },
					{
						cwd: root,
						roots: [root],
						targetFiles: [a],
						sourceFingerprint: artifact.sourceFingerprint,
						hash,
					},
				),
				{ kind: "invalid_plan", reason: "schema" },
			);
		});
	});

	test("changed supplied current source fingerprint fails as stale_sources", async () => {
		await withTempRoot(({ root, a, b }) => {
			const artifact = buildPlanArtifact({
				targets: [a, b],
				units: [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })],
				sourceFingerprint: sourceFingerprint("sources-v1"),
			});

			expectFailure(parseTrustedPlan(artifact, root, [a, b], sourceFingerprint("sources-v2")), {
				kind: "invalid_plan",
				reason: "stale_sources",
			});
		});
	});
});

describe("fingerprint contracts", () => {
	test("planFingerprint ignores createdAt plannerExecution and token changes", async () => {
		await withTempRoot(({ a, b }) => {
			const units = [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })];
			const base = buildPlanArtifact({ targets: [a, b], units });
			const ignored = buildPlanArtifact({
				targets: [a, b],
				units,
				createdAt: "2099-12-31T23:59:59.000Z",
				plannerExecution: plannerExecution({
					durationMs: 9999,
					tokenUsage: {
						input: 100,
						output: 200,
						reasoning: 3,
						cacheRead: 4,
						cacheWrite: 5,
						totalTokens: 312,
					},
					contextTools: {
						enabled: true,
						maxCalls: 24,
						requestedCalls: 9,
						blockedCalls: 2,
						callsByTool: { read: 9 },
					},
				}),
			});

			const left = toValidatedPlan(base, hash);
			const right = toValidatedPlan(ignored, hash);
			expect(left.planFingerprint).toBe(right.planFingerprint);
			expect(left.units.map(unit => unit.unitFingerprint)).toEqual(right.units.map(unit => unit.unitFingerprint));
		});
	});

	test("semantic unit and reviewGoal edits change planFingerprint", async () => {
		await withTempRoot(({ a, b }) => {
			const units = [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })];
			const base = toValidatedPlan(buildPlanArtifact({ targets: [a, b], units }), hash);

			const goalEdited = toValidatedPlan(
				buildPlanArtifact({ targets: [a, b], units, reviewGoal: "Changed goal" }),
				hash,
			);
			expect(goalEdited.planFingerprint).not.toBe(base.planFingerprint);

			const unitEdited = toValidatedPlan(
				buildPlanArtifact({
					targets: [a, b],
					units: [{ ...units[0]!, title: "Changed title" }, units[1]!],
				}),
				hash,
			);
			expect(unitEdited.planFingerprint).not.toBe(base.planFingerprint);
		});
	});

	test("every ReviewUnit field scope edit changes unitFingerprint", async () => {
		await withTempRoot(({ a, b }) => {
			const baseUnit = reviewUnit({
				id: "alpha",
				primaryFiles: [a],
				relatedFiles: [],
				title: "Alpha",
				objective: "Objective",
				reviewFocus: ["focus-a"],
				guideIds: ["contract/state-lifecycle", "contract/errors-handling"],
				riskLevel: "low",
				rationale: "Rationale",
			});
			const companion = reviewUnit({ id: "beta", primaryFiles: [b] });
			const baseFingerprint = toValidatedPlan(
				buildPlanArtifact({ targets: [a, b], units: [baseUnit, companion] }),
				hash,
			).units[0]!.unitFingerprint;

			const fieldEdits: ReviewUnit[] = [
				{ ...baseUnit, id: "alpha-renamed" },
				{ ...baseUnit, title: "Retitled" },
				{ ...baseUnit, objective: "New objective" },
				{ ...baseUnit, relatedFiles: [b] },
				{ ...baseUnit, reviewFocus: ["focus-b"] },
				{ ...baseUnit, guideIds: ["contract/errors-handling", "contract/state-lifecycle"] },
				{ ...baseUnit, riskLevel: "critical" },
				{ ...baseUnit, rationale: "New rationale" },
			];

			for (const edited of fieldEdits) {
				const fingerprint = toValidatedPlan(
					buildPlanArtifact({ targets: [a, b], units: [edited, companion] }),
					hash,
				).units[0]!.unitFingerprint;
				expect(fingerprint).not.toBe(baseFingerprint);
			}

			const primaryFingerprint = toValidatedPlan(
				buildPlanArtifact({
					targets: [a, b],
					units: [
						{ ...baseUnit, primaryFiles: [b] },
						{ ...companion, primaryFiles: [a] },
					],
				}),
				hash,
			).units[0]!.unitFingerprint;
			expect(primaryFingerprint).not.toBe(baseFingerprint);
		});
	});
});

describe("parseReviewerOutput guide provenance", () => {
	test("accepts unit subsets and rejects foreign or duplicate ids", async () => {
		await withTempRoot(({ root, a }) => {
			const unit = reviewUnit({
				id: "alpha",
				primaryFiles: [a],
				guideIds: ["contract/state-lifecycle", "contract/errors-handling"],
			});
			const output = {
				unit_id: "alpha",
				verdict: "NEEDS_REVIEW",
				summary: "One finding",
				findings: [
					{
						id: "finding-a",
						title: "Finding",
						category: "correctness",
						severity: "minor",
						confidence: "high",
						guide_ids: ["contract/errors-handling"],
						evidence: [
							{
								source_id: a,
								start_line: 1,
								end_line: 1,
								quote: "export const value = 1;",
								observation: "Observed line",
							},
						],
						reason: "Contract mismatch",
						suggested_action: "Repair contract",
						verification_after_change: "Re-read source",
					},
				],
				coverage: [{ path: a, status: "reviewed", notes: "Read complete file" }],
			};

			const valid = parseReviewerOutput(output, { cwd: root, roots: [root], unit });
			expect(valid.ok).toBe(true);
			if (!valid.ok) return;
			expect(valid.value.findings[0]?.guideIds).toEqual(["contract/errors-handling"]);

			for (const guideIds of [
				["narrative/readability"],
				["contract/errors-handling", "contract/errors-handling"],
				["unknown/guide"],
			]) {
				const invalid = parseReviewerOutput(
					{
						...output,
						findings: [{ ...output.findings[0]!, guide_ids: guideIds }],
					},
					{ cwd: root, roots: [root], unit },
				);
				expectFailure(invalid, { kind: "invalid_unit_result", reason: "guide_provenance" });
			}
		});
	});
});

describe("parseUnitReviewArtifact stale and foreign contracts", () => {
	test("rejects foreign plan stale unit unknown unit and schema failures", async () => {
		await withTempRoot(({ root, a, b }) => {
			const plan = toValidatedPlan(
				buildPlanArtifact({
					targets: [a, b],
					units: [reviewUnit({ id: "alpha", primaryFiles: [a] }), reviewUnit({ id: "beta", primaryFiles: [b] })],
				}),
				hash,
			);
			const valid = succeededUnitArtifact(plan, "alpha");
			const accepted = parseUnitReviewArtifact(valid, { cwd: root, roots: [root], plan });
			expect(accepted.ok).toBe(true);

			expectFailure(
				parseUnitReviewArtifact({ ...valid, planFingerprint: "b".repeat(64) }, { cwd: root, roots: [root], plan }),
				{ kind: "invalid_unit_result", reason: "foreign_plan" },
			);

			expectFailure(
				parseUnitReviewArtifact({ ...valid, unitFingerprint: "c".repeat(64) }, { cwd: root, roots: [root], plan }),
				{ kind: "invalid_unit_result", reason: "stale_unit" },
			);

			expectFailure(
				parseUnitReviewArtifact(
					{ ...valid, unitId: "missing-unit", review: { ...valid.review, unitId: "missing-unit" } },
					{ cwd: root, roots: [root], plan },
				),
				{ kind: "invalid_unit_result", reason: "unknown_unit" },
			);

			expectFailure(
				parseUnitReviewArtifact(
					{ ...valid, schemaVersion: "unit-review/0.0.0" },
					{ cwd: root, roots: [root], plan },
				),
				{ kind: "invalid_unit_result", reason: "schema" },
			);
		});
	});

	test("rejects a unit artifact after guide selection changes", async () => {
		await withTempRoot(({ root, a }) => {
			const originalPlan = toValidatedPlan(
				buildPlanArtifact({
					targets: [a],
					units: [
						reviewUnit({
							id: "alpha",
							primaryFiles: [a],
							guideIds: ["contract/state-lifecycle"],
						}),
					],
				}),
				hash,
			);
			const staleArtifact = succeededUnitArtifact(originalPlan, "alpha");
			const editedPlan = toValidatedPlan(
				buildPlanArtifact({
					targets: [a],
					units: [
						reviewUnit({
							id: "alpha",
							primaryFiles: [a],
							guideIds: ["contract/errors-handling"],
						}),
					],
				}),
				hash,
			);
			expect(editedPlan.units[0]?.unitFingerprint).not.toBe(originalPlan.units[0]?.unitFingerprint);
			expectFailure(
				parseUnitReviewArtifact(
					{ ...staleArtifact, planFingerprint: editedPlan.planFingerprint },
					{ cwd: root, roots: [root], plan: editedPlan },
				),
				{ kind: "invalid_unit_result", reason: "stale_unit" },
			);
		});
	});

	test("validates persisted finding guide provenance through pure policy", async () => {
		await withTempRoot(({ root, a }) => {
			const plan = toValidatedPlan(
				buildPlanArtifact({
					targets: [a],
					units: [
						reviewUnit({
							id: "alpha",
							primaryFiles: [a],
							guideIds: ["contract/state-lifecycle", "contract/errors-handling"],
						}),
					],
				}),
				hash,
			);
			const artifact = succeededUnitArtifact(plan, "alpha");
			const finding = {
				id: "finding-a",
				title: "Finding",
				category: "correctness",
				severity: "minor",
				confidence: "high",
				guideIds: ["contract/errors-handling"],
				evidence: [
					{
						sourceId: a,
						startLine: 1,
						endLine: 1,
						quote: "export const value = 1;",
						observation: "Observed line",
						hash: hash("evidence"),
					},
				],
				reason: "Contract mismatch",
				suggestedAction: "Repair contract",
				verificationAfterChange: "Re-read source",
			};
			const withFinding = {
				...artifact,
				review: { ...artifact.review, findings: [finding] },
			};
			const accepted = parseUnitReviewArtifact(withFinding, { cwd: root, roots: [root], plan });
			expect(accepted.ok).toBe(true);

			for (const guideIds of [
				["narrative/readability"],
				["contract/errors-handling", "contract/errors-handling"],
				["unknown/guide"],
			]) {
				expectFailure(
					parseUnitReviewArtifact(
						{
							...withFinding,
							review: {
								...withFinding.review,
								findings: [{ ...finding, guideIds }],
							},
						},
						{ cwd: root, roots: [root], plan },
					),
					{ kind: "invalid_unit_result", reason: "guide_provenance" },
				);
			}
		});
	});
});

describe("parseCliCommand grammars", () => {
	test("accepts the exact five command grammars", () => {
		const cwd = process.cwd();
		const fileA = path.resolve(cwd, "src/a.ts");
		const fileB = path.resolve(cwd, "src/b.ts");
		const planPath = path.resolve(cwd, "plan.json");
		const unitOut = path.resolve(cwd, "unit.json");
		const outputDir = path.resolve(cwd, "units");
		const resultsDir = path.resolve(cwd, "results");
		const reportPath = path.resolve(cwd, "report.json");

		expect(
			parseCliCommand([
				"plan",
				"--goal",
				"Review plan",
				"--risk",
				"high",
				"--output",
				"plan.json",
				"--",
				"src/a.ts",
				"src/b.ts",
			]),
		).toEqual({
			ok: true,
			value: {
				command: "plan",
				reviewGoal: "Review plan",
				riskLevel: "high",
				targetFiles: [fileA, fileB],
				outputPath: planPath,
			},
		});

		expect(
			parseCliCommand(["review-unit", "--plan", "plan.json", "--unit", "alpha", "--output", "unit.json"]),
		).toEqual({
			ok: true,
			value: {
				command: "review-unit",
				planPath,
				unitId: "alpha",
				outputPath: unitOut,
			},
		});

		expect(
			parseCliCommand(["review-units", "--plan", "plan.json", "--output-dir", "units", "--units", "alpha,beta"]),
		).toEqual({
			ok: true,
			value: {
				command: "review-units",
				planPath,
				unitIds: ["alpha", "beta"],
				outputDir,
			},
		});

		expect(
			parseCliCommand(["aggregate", "--plan", "plan.json", "--results-dir", "results", "--output", "report.json"]),
		).toEqual({
			ok: true,
			value: {
				command: "aggregate",
				planPath,
				resultsDir,
				outputPath: reportPath,
			},
		});

		expect(parseCliCommand(["run", "--goal", "Review run", "--output", "report.json", "--", "src/a.ts"])).toEqual({
			ok: true,
			value: {
				command: "run",
				reviewGoal: "Review run",
				riskLevel: "medium",
				targetFiles: [fileA],
				outputPath: reportPath,
			},
		});
	});

	test("rejects missing explicit units and required outputs", () => {
		expectFailureKind(
			parseCliCommand(["review-units", "--plan", "plan.json", "--output-dir", "units"]),
			"invalid_cli",
		);
		expectFailureKind(
			parseCliCommand(["review-unit", "--plan", "plan.json", "--output", "unit.json"]),
			"invalid_cli",
		);
		expectFailureKind(parseCliCommand(["plan", "--goal", "Review plan", "--", "src/a.ts"]), "invalid_cli");
		expectFailureKind(
			parseCliCommand(["aggregate", "--plan", "plan.json", "--results-dir", "results"]),
			"invalid_cli",
		);
		expectFailureKind(parseCliCommand(["review-unit", "--plan", "plan.json", "--unit", "alpha"]), "invalid_cli");
	});
});

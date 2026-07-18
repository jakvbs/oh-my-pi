import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type AggregationModelOutput,
	type CoverageItem,
	type Finding,
	PLAN_SCHEMA_VERSION,
	PROMPT_VERSION,
	type PromptExecutionMetadata,
	type ReviewUnit,
	type Severity,
	UNIT_REVIEW_SCHEMA_VERSION,
	type UnitReviewArtifact,
	type ValidatedPlan,
	type ValidatedReviewUnit,
	type Verdict,
	type VerifiedFinding,
} from "./contracts";
import {
	decideAggregationReadiness,
	decideOverallVerdict,
	decideReviewerCoverage,
	decideUnitVerdict,
	deriveCoverageGaps,
	deriveReviewRunState,
	evidenceHashInput,
	materializeFindingGroups,
	validateFindingReferenceConservation,
	validateUnitSelection,
	verifyEvidence,
} from "./review-policy";

const hash = (canonical: string): string => createHash("sha256").update(canonical).digest("hex");

const primaryA = "/repo/src/a.ts";
const primaryB = "/repo/src/b.ts";
const relatedC = "/repo/src/related.ts";

const emptyUsage = {
	input: 1,
	output: 1,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
};

function reviewerExecution(): PromptExecutionMetadata {
	return {
		stage: "reviewer",
		durationMs: 1,
		tokenUsage: emptyUsage,
		contextTools: {
			enabled: true,
			maxCalls: 32,
			requestedCalls: 1,
			blockedCalls: 0,
			callsByTool: { read: 1 },
		},
	};
}

function makeUnit(overrides: Partial<ReviewUnit> & Pick<ReviewUnit, "id">): ReviewUnit {
	return {
		title: overrides.title ?? `Unit ${overrides.id}`,
		objective: overrides.objective ?? `Review ${overrides.id}`,
		primaryFiles: overrides.primaryFiles ?? [primaryA],
		relatedFiles: overrides.relatedFiles ?? [],
		reviewFocus: overrides.reviewFocus ?? ["correctness"],
		riskLevel: overrides.riskLevel ?? "medium",
		rationale: overrides.rationale ?? `Owns ${overrides.id}`,
		...overrides,
	};
}

function makeValidatedUnit(unit: ReviewUnit, unitFingerprint = hash(`unit:${unit.id}`)): ValidatedReviewUnit {
	return { ...unit, unitFingerprint };
}

function makePlan(units: ValidatedReviewUnit[], planFingerprint = hash("plan:v1")): ValidatedPlan {
	return {
		schemaVersion: PLAN_SCHEMA_VERSION,
		promptVersion: PROMPT_VERSION,
		reviewGoal: "Review public contracts",
		riskLevel: "high",
		targetFiles: units.flatMap(unit => unit.primaryFiles),
		sourceFingerprint: hash("sources:v1"),
		units,
		createdAt: "2026-01-01T00:00:00.000Z",
		plannerExecution: {
			stage: "planner",
			durationMs: 1,
			tokenUsage: emptyUsage,
			contextTools: {
				enabled: true,
				maxCalls: 32,
				requestedCalls: 0,
				blockedCalls: 0,
				callsByTool: {},
			},
		},
		planFingerprint,
	};
}

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "id">): Finding {
	return {
		title: overrides.title ?? `Finding ${overrides.id}`,
		category: overrides.category ?? "correctness",
		severity: overrides.severity ?? "minor",
		confidence: overrides.confidence ?? "high",
		evidence: overrides.evidence ?? [],
		reason: overrides.reason ?? "Contract mismatch",
		suggestedAction: overrides.suggestedAction ?? "Tighten the contract",
		verificationAfterChange: overrides.verificationAfterChange ?? "Re-run the unit review",
		...overrides,
	};
}

function makeVerifiedFinding(overrides: Partial<VerifiedFinding> & Pick<VerifiedFinding, "id">): VerifiedFinding {
	const finding = makeFinding(overrides);
	return {
		...finding,
		evidence: overrides.evidence ?? [],
	};
}

function succeededArtifact(input: {
	plan: ValidatedPlan;
	unitId: string;
	findings?: VerifiedFinding[];
	coverage?: CoverageItem[];
	verdict?: Verdict;
	planFingerprint?: string;
	unitFingerprint?: string;
}): UnitReviewArtifact {
	const unit = input.plan.units.find(item => item.id === input.unitId);
	if (!unit) {
		throw new Error(`Unknown unit fixture: ${input.unitId}`);
	}
	const coverage =
		input.coverage ??
		unit.primaryFiles.map(path => ({
			path,
			status: "reviewed" as const,
			notes: "Read complete implementation",
		}));
	return {
		schemaVersion: UNIT_REVIEW_SCHEMA_VERSION,
		planFingerprint: input.planFingerprint ?? input.plan.planFingerprint,
		unitId: input.unitId,
		unitFingerprint: input.unitFingerprint ?? unit.unitFingerprint,
		status: "succeeded",
		review: {
			unitId: input.unitId,
			verdict: input.verdict ?? (input.findings?.length ? "NEEDS_REVIEW" : "PASS"),
			summary: input.findings?.length ? "Findings present" : "No defects",
			findings: input.findings ?? [],
			coverage,
		},
		execution: reviewerExecution(),
	};
}

function failedArtifact(input: {
	plan: ValidatedPlan;
	unitId: string;
	message?: string;
	planFingerprint?: string;
	unitFingerprint?: string;
}): UnitReviewArtifact {
	const unit = input.plan.units.find(item => item.id === input.unitId);
	if (!unit) {
		throw new Error(`Unknown unit fixture: ${input.unitId}`);
	}
	return {
		schemaVersion: UNIT_REVIEW_SCHEMA_VERSION,
		planFingerprint: input.planFingerprint ?? input.plan.planFingerprint,
		unitId: input.unitId,
		unitFingerprint: input.unitFingerprint ?? unit.unitFingerprint,
		status: "failed",
		failure: {
			kind: "prompt_failed",
			stage: "reviewer",
			unitId: input.unitId,
			message: input.message ?? `Reviewer failed for ${input.unitId}`,
		},
		execution: reviewerExecution(),
	};
}

function aggregationOutput(
	overrides: Partial<AggregationModelOutput> & Pick<AggregationModelOutput, "orderedGroups">,
): AggregationModelOutput {
	return {
		overallSummary: overrides.overallSummary ?? "Aggregated review",
		coverageGaps: overrides.coverageGaps ?? [],
		orderedGroups: overrides.orderedGroups,
	};
}

describe("decideUnitVerdict", () => {
	const rows: Array<{
		name: string;
		findings: Array<{ severity: Severity }>;
		hasUnavailableCoverage: boolean;
		expected: Verdict;
	}> = [
		{
			name: "unavailable coverage yields INSUFFICIENT_CONTEXT",
			findings: [{ severity: "critical" }],
			hasUnavailableCoverage: true,
			expected: "INSUFFICIENT_CONTEXT",
		},
		{
			name: "major or critical finding yields FAIL",
			findings: [{ severity: "major" }],
			hasUnavailableCoverage: false,
			expected: "FAIL",
		},
		{
			name: "non-serious finding yields NEEDS_REVIEW",
			findings: [{ severity: "minor" }],
			hasUnavailableCoverage: false,
			expected: "NEEDS_REVIEW",
		},
		{
			name: "no findings yields PASS",
			findings: [],
			hasUnavailableCoverage: false,
			expected: "PASS",
		},
	];

	for (const row of rows) {
		test(row.name, () => {
			expect(
				decideUnitVerdict({
					findings: row.findings,
					hasUnavailableCoverage: row.hasUnavailableCoverage,
				}),
			).toBe(row.expected);
		});
	}
});

describe("decideOverallVerdict", () => {
	const rows: Array<{
		name: string;
		findings: Array<{ severity: Severity }>;
		incomplete: boolean;
		expected: Verdict;
	}> = [
		{
			name: "incomplete yields INSUFFICIENT_CONTEXT",
			findings: [{ severity: "critical" }],
			incomplete: true,
			expected: "INSUFFICIENT_CONTEXT",
		},
		{
			name: "major or critical finding yields FAIL",
			findings: [{ severity: "critical" }],
			incomplete: false,
			expected: "FAIL",
		},
		{
			name: "non-serious finding yields NEEDS_REVIEW",
			findings: [{ severity: "heuristic" }],
			incomplete: false,
			expected: "NEEDS_REVIEW",
		},
		{
			name: "no findings yields PASS",
			findings: [],
			incomplete: false,
			expected: "PASS",
		},
	];

	for (const row of rows) {
		test(row.name, () => {
			expect(
				decideOverallVerdict({
					findings: row.findings,
					incomplete: row.incomplete,
				}),
			).toBe(row.expected);
		});
	}
});

describe("decideReviewerCoverage", () => {
	const unit = makeUnit({
		id: "alpha",
		primaryFiles: [primaryA, primaryB],
	});

	test("accepts the exact primary coverage set", () => {
		const result = decideReviewerCoverage({
			unit,
			coverage: [
				{ path: primaryB, status: "reviewed", notes: "Read b" },
				{ path: primaryA, status: "reviewed", notes: "Read a" },
			],
			readPaths: new Set([primaryA, primaryB]),
		});

		expect(result).toEqual({
			ok: true,
			value: {
				coverage: [
					{ path: primaryA, status: "reviewed", notes: "Read a" },
					{ path: primaryB, status: "reviewed", notes: "Read b" },
				],
				hasUnavailable: false,
			},
		});
	});

	test("rejects omitted primary coverage as invalid_coverage", () => {
		const result = decideReviewerCoverage({
			unit,
			coverage: [{ path: primaryA, status: "reviewed", notes: "Read a" }],
			readPaths: new Set([primaryA]),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toMatchObject({
			kind: "invalid_coverage",
			unitId: "alpha",
		});
	});
});

describe("verifyEvidence", () => {
	const sourceContent = ["export function add(a: number, b: number) {", "\treturn a + b;", "}"].join("\n");

	test("rejects a fabricated quote as invalid_evidence", () => {
		const result = verifyEvidence({
			unitId: "alpha",
			findings: [
				makeFinding({
					id: "fabricated",
					evidence: [
						{
							sourceId: primaryA,
							startLine: 2,
							endLine: 2,
							quote: "\treturn a - b;",
							observation: "Quote does not match source",
						},
					],
				}),
			],
			sourceSnapshots: [{ sourceId: primaryA, content: sourceContent, wasRead: true }],
			allowedSourceIds: new Set([primaryA]),
			hash,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toMatchObject({
			kind: "invalid_evidence",
			unitId: "alpha",
			findingId: "fabricated",
			sourceId: primaryA,
		});
	});

	test("rejects an unread source as invalid_evidence", () => {
		const result = verifyEvidence({
			unitId: "alpha",
			findings: [
				makeFinding({
					id: "unread",
					evidence: [
						{
							sourceId: primaryA,
							startLine: 2,
							endLine: 2,
							quote: "\treturn a + b;",
							observation: "Unread citation",
						},
					],
				}),
			],
			sourceSnapshots: [{ sourceId: primaryA, content: sourceContent, wasRead: false }],
			allowedSourceIds: new Set([primaryA]),
			hash,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toMatchObject({
			kind: "invalid_evidence",
			unitId: "alpha",
			findingId: "unread",
			sourceId: primaryA,
		});
	});

	test("hashes an exact complete line deterministically and repeats for the same input", () => {
		const quote = "\treturn a + b;";
		const finding = makeFinding({
			id: "exact-line",
			evidence: [
				{
					sourceId: primaryA,
					startLine: 2,
					endLine: 2,
					quote,
					observation: "Exact source line",
				},
			],
		});
		const input = {
			unitId: "alpha",
			findings: [finding],
			sourceSnapshots: [{ sourceId: primaryA, content: sourceContent, wasRead: true }],
			allowedSourceIds: new Set([primaryA]),
			hash,
		};

		const first = verifyEvidence(input);
		const second = verifyEvidence(input);
		const expectedHash = hash(
			evidenceHashInput({
				sourceId: primaryA,
				startLine: 2,
				endLine: 2,
				quote,
			}),
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.value[0]?.evidence[0]?.hash).toBe(expectedHash);
		expect(second.value[0]?.evidence[0]?.hash).toBe(expectedHash);
		expect(first.value[0]?.evidence[0]?.hash).toBe(second.value[0]?.evidence[0]?.hash);
	});

	test("allows related context sources in the allowed set", () => {
		const relatedContent = "export type Sum = number;\n";
		const result = verifyEvidence({
			unitId: "alpha",
			findings: [
				makeFinding({
					id: "related-context",
					evidence: [
						{
							sourceId: relatedC,
							startLine: 1,
							endLine: 1,
							quote: "export type Sum = number;",
							observation: "Related type contract",
						},
					],
				}),
			],
			sourceSnapshots: [{ sourceId: relatedC, content: relatedContent, wasRead: true }],
			allowedSourceIds: new Set([primaryA, relatedC]),
			hash,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value[0]?.evidence[0]).toMatchObject({
			sourceId: relatedC,
			startLine: 1,
			endLine: 1,
			quote: "export type Sum = number;",
		});
		expect(result.value[0]?.evidence[0]?.hash).toHaveLength(64);
	});
});

describe("validateUnitSelection", () => {
	const plan = makePlan([
		makeValidatedUnit(makeUnit({ id: "alpha", primaryFiles: [primaryA] })),
		makeValidatedUnit(makeUnit({ id: "beta", primaryFiles: [primaryB] })),
	]);

	test("rejects an unknown unit id", () => {
		const result = validateUnitSelection(plan, ["alpha", "gamma"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "unknown_unit",
			unitId: "gamma",
			message: "Unknown unit id selected: gamma",
		});
	});

	test("rejects a duplicate unit id", () => {
		const result = validateUnitSelection(plan, ["alpha", "alpha"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "duplicate_unit",
			unitId: "alpha",
			message: "Duplicate unit id selected: alpha",
		});
	});
});

describe("decideAggregationReadiness", () => {
	const plan = makePlan([
		makeValidatedUnit(makeUnit({ id: "alpha", primaryFiles: [primaryA] }), hash("unit:alpha")),
		makeValidatedUnit(makeUnit({ id: "beta", primaryFiles: [primaryB] }), hash("unit:beta")),
	]);

	test("blocks when a unit result is missing", () => {
		const result = decideAggregationReadiness(plan, [succeededArtifact({ plan, unitId: "alpha" })]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_aggregation",
			reason: "missing_results",
			message: "Expected 2 unit results, received 1",
		});
	});

	test("treats failed unit artifacts as terminal and ready", () => {
		const result = decideAggregationReadiness(plan, [
			succeededArtifact({ plan, unitId: "alpha" }),
			failedArtifact({ plan, unitId: "beta", message: "Model timed out" }),
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(artifact => artifact.unitId)).toEqual(["alpha", "beta"]);
		expect(result.value[1]?.status).toBe("failed");
	});

	test("rejects a foreign plan fingerprint as invalid_unit_result", () => {
		const result = decideAggregationReadiness(plan, [
			succeededArtifact({ plan, unitId: "alpha" }),
			succeededArtifact({
				plan,
				unitId: "beta",
				planFingerprint: hash("plan:other"),
			}),
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "foreign_plan",
			unitId: "beta",
			message: "Unit beta belongs to a different plan fingerprint",
		});
	});

	test("rejects a stale unit fingerprint as invalid_unit_result", () => {
		const result = decideAggregationReadiness(plan, [
			succeededArtifact({ plan, unitId: "alpha" }),
			succeededArtifact({
				plan,
				unitId: "beta",
				unitFingerprint: hash("unit:stale"),
			}),
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "stale_unit",
			unitId: "beta",
			message: "Unit beta fingerprint does not match the validated plan",
		});
	});

	test("rejects a duplicate unit result as invalid_unit_result", () => {
		const result = decideAggregationReadiness(plan, [
			succeededArtifact({ plan, unitId: "alpha" }),
			succeededArtifact({ plan, unitId: "alpha" }),
			succeededArtifact({ plan, unitId: "beta" }),
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "duplicate_unit",
			unitId: "alpha",
			message: "Duplicate unit result: alpha",
		});
	});

	test("rejects an unknown unit result as invalid_unit_result", () => {
		const result = decideAggregationReadiness(plan, [
			succeededArtifact({ plan, unitId: "alpha" }),
			{
				...succeededArtifact({ plan, unitId: "beta" }),
				unitId: "gamma",
			},
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_unit_result",
			reason: "unknown_unit",
			unitId: "gamma",
			message: "Unknown unit result: gamma",
		});
	});

	test("accepts one terminal artifact per plan unit", () => {
		const result = decideAggregationReadiness(plan, [
			failedArtifact({ plan, unitId: "alpha" }),
			succeededArtifact({ plan, unitId: "beta" }),
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(artifact => ({ unitId: artifact.unitId, status: artifact.status }))).toEqual([
			{ unitId: "alpha", status: "failed" },
			{ unitId: "beta", status: "succeeded" },
		]);
	});
});

describe("finding-reference conservation and materialization", () => {
	const plan = makePlan([
		makeValidatedUnit(makeUnit({ id: "alpha", primaryFiles: [primaryA] }), hash("unit:alpha")),
		makeValidatedUnit(makeUnit({ id: "beta", primaryFiles: [primaryB] }), hash("unit:beta")),
	]);

	const alphaFinding = makeVerifiedFinding({
		id: "null-check",
		severity: "major",
		confidence: "high",
		category: "correctness",
		evidence: [
			{
				sourceId: primaryA,
				startLine: 1,
				endLine: 1,
				quote: "export function add(a: number, b: number) {",
				observation: "No null policy",
				hash: hash("evidence:alpha"),
			},
		],
	});
	const betaFinding = makeVerifiedFinding({
		id: "format-drift",
		severity: "minor",
		confidence: "low",
		category: "consistency",
		evidence: [
			{
				sourceId: primaryB,
				startLine: 1,
				endLine: 1,
				quote: "export const format = (value: number) => String(value);",
				observation: "Format contract is implicit",
				hash: hash("evidence:beta"),
			},
		],
	});

	const unitResults: UnitReviewArtifact[] = [
		succeededArtifact({
			plan,
			unitId: "alpha",
			findings: [alphaFinding],
			verdict: "FAIL",
		}),
		succeededArtifact({
			plan,
			unitId: "beta",
			findings: [betaFinding],
			verdict: "NEEDS_REVIEW",
		}),
	];

	test("rejects an unknown finding reference", () => {
		const result = validateFindingReferenceConservation(
			aggregationOutput({
				orderedGroups: [
					{
						findingRefs: [
							{ unitId: "alpha", findingId: "null-check" },
							{ unitId: "beta", findingId: "missing" },
						],
						title: "Unknown ref",
						reason: "References a finding that does not exist",
						recommendedAction: "Drop the unknown ref",
						verificationAfterChange: "Re-validate conservation",
					},
				],
			}),
			unitResults,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_aggregation",
			reason: "unknown_finding",
			message: "Aggregator referenced unknown finding: beta/missing",
			findingRef: "beta/missing",
		});
	});

	test("rejects a duplicate finding reference", () => {
		const result = validateFindingReferenceConservation(
			aggregationOutput({
				orderedGroups: [
					{
						findingRefs: [
							{ unitId: "alpha", findingId: "null-check" },
							{ unitId: "alpha", findingId: "null-check" },
						],
						title: "Duplicate ref",
						reason: "Repeats the same finding",
						recommendedAction: "Keep one reference",
						verificationAfterChange: "Re-validate conservation",
					},
				],
			}),
			unitResults,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_aggregation",
			reason: "duplicate_finding",
			message: "Aggregator repeated finding: alpha/null-check",
			findingRef: "alpha/null-check",
		});
	});

	test("rejects an omitted finding reference", () => {
		const result = validateFindingReferenceConservation(
			aggregationOutput({
				orderedGroups: [
					{
						findingRefs: [{ unitId: "alpha", findingId: "null-check" }],
						title: "Omitted ref",
						reason: "Leaves beta uncovered",
						recommendedAction: "Include every succeeded finding",
						verificationAfterChange: "Re-validate conservation",
					},
				],
			}),
			unitResults,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toEqual({
			kind: "invalid_aggregation",
			reason: "omitted_finding",
			message: "Aggregator omitted finding: beta/format-drift",
			findingRef: "beta/format-drift",
		});
	});

	test("materializes each ref once without reducing maximum severity or minimum confidence", () => {
		const output = aggregationOutput({
			orderedGroups: [
				{
					findingRefs: [
						{ unitId: "alpha", findingId: "null-check" },
						{ unitId: "beta", findingId: "format-drift" },
					],
					title: "Contract gaps",
					reason: "Both units expose contract risk",
					recommendedAction: "Align null and format contracts",
					verificationAfterChange: "Cover both paths in tests",
				},
			],
		});

		const result = materializeFindingGroups(output, unitResults);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(1);
		expect(result.value[0]).toMatchObject({
			sourceFindings: ["alpha/null-check", "beta/format-drift"],
			severity: "major",
			confidence: "low",
			categories: ["correctness", "consistency"],
		});
		expect(result.value[0]?.sourceFindings).toEqual(["alpha/null-check", "beta/format-drift"]);
		expect(new Set(result.value[0]?.sourceFindings).size).toBe(2);
		expect(result.value[0]?.severity).toBe("major");
		expect(result.value[0]?.confidence).toBe("low");
	});

	test("turns failed units into coverage gaps", () => {
		const mixedResults: UnitReviewArtifact[] = [
			succeededArtifact({
				plan,
				unitId: "alpha",
				findings: [alphaFinding],
				verdict: "FAIL",
			}),
			failedArtifact({
				plan,
				unitId: "beta",
				message: "Reviewer aborted before coverage",
			}),
		];
		const output = aggregationOutput({
			orderedGroups: [
				{
					findingRefs: [{ unitId: "alpha", findingId: "null-check" }],
					title: "Null policy",
					reason: "Only the succeeded unit contributed findings",
					recommendedAction: "Define the null policy",
					verificationAfterChange: "Add a null-input test",
				},
			],
			coverageGaps: [],
		});

		const result = deriveCoverageGaps(output, mixedResults, plan);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual([
			{
				unitId: "beta",
				path: primaryB,
				reason: "Reviewer aborted before coverage",
			},
		]);
	});
});

describe("deriveReviewRunState", () => {
	const plan = makePlan([
		makeValidatedUnit(makeUnit({ id: "alpha", primaryFiles: [primaryA] }), hash("unit:alpha")),
		makeValidatedUnit(makeUnit({ id: "beta", primaryFiles: [primaryB] }), hash("unit:beta")),
	]);

	test("returns planned when there are no unit results", () => {
		expect(deriveReviewRunState(plan, [], false)).toEqual({ state: "planned" });
	});

	test("returns reviewing with completed and pending unit ids", () => {
		expect(deriveReviewRunState(plan, [succeededArtifact({ plan, unitId: "alpha" })], false)).toEqual({
			state: "reviewing",
			completedUnitIds: ["alpha"],
			pendingUnitIds: ["beta"],
		});
	});

	test("returns ready_to_aggregate when every unit is terminal", () => {
		expect(
			deriveReviewRunState(
				plan,
				[succeededArtifact({ plan, unitId: "alpha" }), failedArtifact({ plan, unitId: "beta" })],
				false,
			),
		).toEqual({ state: "ready_to_aggregate" });
	});

	test("returns completed when a report is present", () => {
		expect(
			deriveReviewRunState(
				plan,
				[succeededArtifact({ plan, unitId: "alpha" }), succeededArtifact({ plan, unitId: "beta" })],
				true,
			),
		).toEqual({ state: "completed" });
	});
});

import { isAbsolute, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";
import type { ContextToolMode } from "./context-tools";

/** Stable versions shared by plan/unit/report artifacts and prompt metadata. */
export const PROMPT_VERSION = "filesystem-model-routed-review/2.0.0" as const;
export const PLAN_SCHEMA_VERSION = "review-plan/1.0.0" as const;
export const UNIT_REVIEW_SCHEMA_VERSION = "unit-review/1.0.0" as const;
export const REPORT_SCHEMA_VERSION = "review-report/1.0.0" as const;
export const CONTEXT_TOOL_POLICY_VERSION = "read-only-filesystem/1.0.0" as const;

const MAX_PRIMARY_FILES_PER_UNIT = 8;
const MAX_RELATED_FILES_PER_UNIT = 20;
const MAX_REVIEW_FOCUS = 8;
const MAX_UNITS = 100;
const MAX_FINDINGS_PER_UNIT = 30;
const MAX_EVIDENCE_PER_FINDING = 10;

const identifierRegex = /^[a-z0-9][a-z0-9._-]*$/;

const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const severitySchema = z.enum(["heuristic", "minor", "major", "critical"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const verdictSchema = z.enum(["PASS", "FAIL", "NEEDS_REVIEW", "INSUFFICIENT_CONTEXT"]);
const promptStageSchema = z.enum(["planner", "reviewer", "aggregator"]);
const identifierSchema = z.string().regex(identifierRegex);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1);
const absolutePathStringSchema = nonEmptyStringSchema;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type PromptStage = z.infer<typeof promptStageSchema>;

export type TokenUsage = {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type PromptExecutionMetadata = {
	stage: PromptStage;
	durationMs: number;
	tokenUsage: TokenUsage;
	contextTools: {
		enabled: boolean;
		maxCalls: number;
		requestedCalls: number;
		blockedCalls: number;
		callsByTool: Record<string, number>;
	};
};

export type PromptResult<Output> = {
	output: Output;
	execution: PromptExecutionMetadata;
	contextReadPaths?: string[];
};

export type PromptRunner = <Output>(request: {
	stage: PromptStage;
	resultSchema: z.ZodType<Output>;
	systemPrompt: string;
	userPrompt: string;
	contextTools?: { mode: ContextToolMode; roots: string[] };
	thinkingLevel?: ThinkingLevel;
}) => Promise<PromptResult<Output>>;

export type ReviewFailure =
	| {
			kind: "prompt_failed";
			stage: PromptStage;
			unitId?: string;
			message: string;
	  }
	| {
			kind: "invalid_plan";
			reason: "schema" | "path" | "ownership" | "duplicate_unit" | "unknown_target" | "stale_sources";
			message: string;
			target?: string;
	  }
	| {
			kind: "invalid_coverage";
			unitId: string;
			path?: string;
			message: string;
	  }
	| {
			kind: "invalid_evidence";
			unitId: string;
			findingId?: string;
			sourceId?: string;
			message: string;
	  }
	| {
			kind: "invalid_unit_result";
			reason: "schema" | "unknown_unit" | "duplicate_unit" | "foreign_plan" | "stale_unit" | "non_terminal";
			unitId?: string;
			message: string;
	  }
	| {
			kind: "invalid_aggregation";
			reason: "missing_results" | "unknown_finding" | "duplicate_finding" | "omitted_finding" | "invalid_group";
			message: string;
			findingRef?: string;
	  };

export type ReviewOutcome<T> = { ok: true; value: T } | { ok: false; failure: ReviewFailure };

export type ReviewUnit = {
	id: string;
	title: string;
	objective: string;
	primaryFiles: string[];
	relatedFiles: string[];
	reviewFocus: string[];
	riskLevel: RiskLevel;
	rationale: string;
};

export type ValidatedReviewUnit = ReviewUnit & { unitFingerprint: string };

export type PlanArtifact = {
	schemaVersion: typeof PLAN_SCHEMA_VERSION;
	promptVersion: typeof PROMPT_VERSION;
	reviewGoal: string;
	riskLevel: RiskLevel;
	targetFiles: string[];
	sourceFingerprint: string;
	units: ReviewUnit[];
	createdAt: string;
	plannerExecution: PromptExecutionMetadata;
};

export type ValidatedPlan = Omit<PlanArtifact, "units"> & {
	planFingerprint: string;
	units: ValidatedReviewUnit[];
};

export type Evidence = {
	sourceId: string;
	startLine: number;
	endLine: number;
	quote: string;
	observation: string;
};

export type VerifiedEvidence = {
	sourceId: string;
	startLine: number;
	endLine: number;
	quote: string;
	observation: string;
	hash: string;
};

export type Finding = {
	id: string;
	title: string;
	category: string;
	severity: Severity;
	confidence: Confidence;
	evidence: Evidence[];
	reason: string;
	suggestedAction: string;
	verificationAfterChange: string;
};

export type VerifiedFinding = Omit<Finding, "evidence"> & { evidence: VerifiedEvidence[] };

export type CoverageItem = {
	path: string;
	status: "reviewed" | "unavailable";
	notes: string;
};

/** Canonical reviewer-model semantics after path normalization (pre-policy). */
export type ReviewerOutput = {
	unitId: string;
	verdict: Verdict;
	summary: string;
	findings: Finding[];
	coverage: CoverageItem[];
};

export type VerifiedUnitReview = {
	unitId: string;
	verdict: Verdict;
	summary: string;
	findings: VerifiedFinding[];
	coverage: CoverageItem[];
};

/** Alias used by review-runner / assignment wording. */
export type UnitReview = VerifiedUnitReview;

export type UnitReviewArtifact =
	| {
			schemaVersion: typeof UNIT_REVIEW_SCHEMA_VERSION;
			planFingerprint: string;
			unitId: string;
			unitFingerprint: string;
			status: "succeeded";
			review: VerifiedUnitReview;
			execution: PromptExecutionMetadata;
	  }
	| {
			schemaVersion: typeof UNIT_REVIEW_SCHEMA_VERSION;
			planFingerprint: string;
			unitId: string;
			unitFingerprint: string;
			status: "failed";
			failure: ReviewFailure;
			execution?: PromptExecutionMetadata;
	  };

export type FindingReference = {
	unitId: string;
	findingId: string;
};

/** Canonical aggregator-model semantics after path normalization. */
export type AggregationModelOutput = {
	overallSummary: string;
	orderedGroups: Array<{
		findingRefs: FindingReference[];
		title: string;
		reason: string;
		recommendedAction: string;
		verificationAfterChange: string;
	}>;
	coverageGaps: Array<{
		unitId: string;
		path: string;
		reason: string;
	}>;
};

export type AggregatedFinding = {
	id: string;
	sourceFindings: string[];
	unitIds: string[];
	title: string;
	categories: string[];
	severity: Severity;
	confidence: Confidence;
	evidence: VerifiedEvidence[];
	reason: string;
	suggestedAction: string;
	verificationAfterChange: string;
};

export type ReviewReport = {
	version: typeof REPORT_SCHEMA_VERSION;
	planFingerprint: string;
	reviewGoal: string;
	riskLevel: RiskLevel;
	incomplete: boolean;
	units: UnitReviewArtifact[];
	findings: AggregatedFinding[];
	coverageGaps: Array<{ unitId: string; path: string; reason: string }>;
	aggregate: {
		summary: string;
		counts: {
			unitCount: number;
			completedUnitCount: number;
			findingCount: number;
			countsBySeverity: Record<Severity, number>;
		};
		verdict: Verdict;
	};
	execution: {
		startedAt: string;
		durationMs: number;
		modelId: string;
		thinkingLevel: string;
		promptVersion: typeof PROMPT_VERSION;
		outputSchemaVersion: typeof REPORT_SCHEMA_VERSION;
		contextToolPolicyVersion: typeof CONTEXT_TOOL_POLICY_VERSION;
		tokenUsage: TokenUsage;
		contextTools: {
			requestedCalls: number;
			blockedCalls: number;
			callsByTool: Record<string, number>;
		};
		planner: PromptExecutionMetadata;
		reviewers: PromptExecutionMetadata[];
		aggregator: PromptExecutionMetadata;
	};
};

export type AggregationInput = {
	plan: ValidatedPlan;
	unitReviews: UnitReviewArtifact[];
};

export type ReviewRunState =
	| { state: "planned" }
	| {
			state: "reviewing";
			completedUnitIds: readonly string[];
			pendingUnitIds: readonly string[];
	  }
	| { state: "ready_to_aggregate" }
	| { state: "completed" };

/** Canonical planner-model semantics after path/ownership normalization. */
export type PlannerOutput = {
	overview: string;
	units: ReviewUnit[];
};

export type CliCommand =
	| {
			command: "plan";
			reviewGoal: string;
			riskLevel: RiskLevel;
			targetFiles: string[];
			outputPath: string;
	  }
	| {
			command: "review-unit";
			planPath: string;
			unitId: string;
			outputPath: string;
	  }
	| {
			command: "review-units";
			planPath: string;
			unitIds: string[];
			outputDir: string;
	  }
	| {
			command: "aggregate";
			planPath: string;
			resultsDir: string;
			outputPath: string;
	  }
	| {
			command: "run";
			reviewGoal: string;
			riskLevel: RiskLevel;
			targetFiles: string[];
			outputPath?: string;
	  };

/** Injected hasher over deterministic canonical JSON strings. */
export type HashFn = (canonical: string) => string;

export type PathNormalizationContext = {
	cwd: string;
	roots: string[];
};

export type PlannerOutputParseContext = PathNormalizationContext & {
	targetFiles: string[];
};

export type PlanArtifactParseContext = PathNormalizationContext & {
	targetFiles: string[];
	sourceFingerprint: string;
	hash: HashFn;
};

export type ReviewerOutputParseContext = PathNormalizationContext & {
	unit: ReviewUnit;
};

export type UnitReviewArtifactParseContext = PathNormalizationContext & {
	plan: ValidatedPlan;
	seenUnitIds?: Iterable<string>;
};

export type AggregationModelOutputParseContext = {
	plan: ValidatedPlan;
	knownFindingRefs: Iterable<string>;
	cwd: string;
};

const tokenUsageSchema = z
	.object({
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
		reasoning: z.number().nonnegative(),
		cacheRead: z.number().nonnegative(),
		cacheWrite: z.number().nonnegative(),
		totalTokens: z.number().nonnegative(),
	})
	.strict();

const promptExecutionMetadataSchema = z
	.object({
		stage: promptStageSchema,
		durationMs: z.number().nonnegative(),
		tokenUsage: tokenUsageSchema,
		contextTools: z
			.object({
				enabled: z.boolean(),
				maxCalls: z.number().int().nonnegative(),
				requestedCalls: z.number().int().nonnegative(),
				blockedCalls: z.number().int().nonnegative(),
				callsByTool: z.record(z.string(), z.number().int().nonnegative()),
			})
			.strict(),
	})
	.strict();

const rawReviewUnitSchema = z
	.object({
		id: identifierSchema,
		title: nonEmptyStringSchema,
		objective: nonEmptyStringSchema,
		primary_files: z.array(absolutePathStringSchema).min(1).max(MAX_PRIMARY_FILES_PER_UNIT),
		related_files: z.array(absolutePathStringSchema).max(MAX_RELATED_FILES_PER_UNIT),
		review_focus: z.array(nonEmptyStringSchema).min(1).max(MAX_REVIEW_FOCUS),
		risk_level: riskLevelSchema,
		rationale: nonEmptyStringSchema,
	})
	.strict();

const rawPlannerOutputSchema = z
	.object({
		overview: nonEmptyStringSchema,
		units: z.array(rawReviewUnitSchema).min(1).max(MAX_UNITS),
	})
	.strict();

const trustedReviewUnitSchema = z
	.object({
		id: identifierSchema,
		title: nonEmptyStringSchema,
		objective: nonEmptyStringSchema,
		primaryFiles: z.array(absolutePathStringSchema).min(1).max(MAX_PRIMARY_FILES_PER_UNIT),
		relatedFiles: z.array(absolutePathStringSchema).max(MAX_RELATED_FILES_PER_UNIT),
		reviewFocus: z.array(nonEmptyStringSchema).min(1).max(MAX_REVIEW_FOCUS),
		riskLevel: riskLevelSchema,
		rationale: nonEmptyStringSchema,
	})
	.strict();

const planArtifactSchema = z
	.object({
		schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
		promptVersion: z.literal(PROMPT_VERSION),
		reviewGoal: nonEmptyStringSchema,
		riskLevel: riskLevelSchema,
		targetFiles: z.array(absolutePathStringSchema).min(1),
		sourceFingerprint: fingerprintSchema,
		units: z.array(trustedReviewUnitSchema).min(1).max(MAX_UNITS),
		createdAt: isoDateTimeSchema,
		plannerExecution: promptExecutionMetadataSchema,
	})
	.strict();

const rawEvidenceSchema = z
	.object({
		source_id: absolutePathStringSchema,
		start_line: z.number().int().positive(),
		end_line: z.number().int().positive(),
		quote: nonEmptyStringSchema,
		observation: nonEmptyStringSchema,
	})
	.strict();

const rawFindingSchema = z
	.object({
		id: identifierSchema,
		title: nonEmptyStringSchema,
		category: nonEmptyStringSchema,
		severity: severitySchema,
		confidence: confidenceSchema,
		evidence: z.array(rawEvidenceSchema).min(1).max(MAX_EVIDENCE_PER_FINDING),
		reason: nonEmptyStringSchema,
		suggested_action: nonEmptyStringSchema,
		verification_after_change: nonEmptyStringSchema,
	})
	.strict();

const rawCoverageSchema = z
	.object({
		path: absolutePathStringSchema,
		status: z.enum(["reviewed", "unavailable"]),
		notes: nonEmptyStringSchema,
	})
	.strict();

const rawReviewerOutputSchema = z
	.object({
		unit_id: identifierSchema,
		verdict: verdictSchema,
		summary: nonEmptyStringSchema,
		findings: z.array(rawFindingSchema).max(MAX_FINDINGS_PER_UNIT),
		coverage: z.array(rawCoverageSchema).min(1),
	})
	.strict();

const verifiedEvidenceSchema = z
	.object({
		sourceId: absolutePathStringSchema,
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		quote: nonEmptyStringSchema,
		observation: nonEmptyStringSchema,
		hash: fingerprintSchema,
	})
	.strict();

const verifiedFindingSchema = z
	.object({
		id: identifierSchema,
		title: nonEmptyStringSchema,
		category: nonEmptyStringSchema,
		severity: severitySchema,
		confidence: confidenceSchema,
		evidence: z.array(verifiedEvidenceSchema).min(1).max(MAX_EVIDENCE_PER_FINDING),
		reason: nonEmptyStringSchema,
		suggestedAction: nonEmptyStringSchema,
		verificationAfterChange: nonEmptyStringSchema,
	})
	.strict();

const coverageItemSchema = z
	.object({
		path: absolutePathStringSchema,
		status: z.enum(["reviewed", "unavailable"]),
		notes: nonEmptyStringSchema,
	})
	.strict();

const verifiedUnitReviewSchema = z
	.object({
		unitId: identifierSchema,
		verdict: verdictSchema,
		summary: nonEmptyStringSchema,
		findings: z.array(verifiedFindingSchema).max(MAX_FINDINGS_PER_UNIT),
		coverage: z.array(coverageItemSchema).min(1),
	})
	.strict();

const reviewFailureSchema: z.ZodType<ReviewFailure> = z.union([
	z
		.object({
			kind: z.literal("prompt_failed"),
			stage: promptStageSchema,
			unitId: identifierSchema.optional(),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_plan"),
			reason: z.enum(["schema", "path", "ownership", "duplicate_unit", "unknown_target", "stale_sources"]),
			message: nonEmptyStringSchema,
			target: nonEmptyStringSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_coverage"),
			unitId: identifierSchema,
			path: absolutePathStringSchema.optional(),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_evidence"),
			unitId: identifierSchema,
			findingId: identifierSchema.optional(),
			sourceId: absolutePathStringSchema.optional(),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_unit_result"),
			reason: z.enum(["schema", "unknown_unit", "duplicate_unit", "foreign_plan", "stale_unit", "non_terminal"]),
			unitId: identifierSchema.optional(),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_aggregation"),
			reason: z.enum([
				"missing_results",
				"unknown_finding",
				"duplicate_finding",
				"omitted_finding",
				"invalid_group",
			]),
			message: nonEmptyStringSchema,
			findingRef: nonEmptyStringSchema.optional(),
		})
		.strict(),
]);

const unitReviewArtifactSchema = z.union([
	z
		.object({
			schemaVersion: z.literal(UNIT_REVIEW_SCHEMA_VERSION),
			planFingerprint: fingerprintSchema,
			unitId: identifierSchema,
			unitFingerprint: fingerprintSchema,
			status: z.literal("succeeded"),
			review: verifiedUnitReviewSchema,
			execution: promptExecutionMetadataSchema,
		})
		.strict(),
	z
		.object({
			schemaVersion: z.literal(UNIT_REVIEW_SCHEMA_VERSION),
			planFingerprint: fingerprintSchema,
			unitId: identifierSchema,
			unitFingerprint: fingerprintSchema,
			status: z.literal("failed"),
			failure: reviewFailureSchema,
			execution: promptExecutionMetadataSchema.optional(),
		})
		.strict(),
]);

const rawFindingReferenceSchema = z
	.object({
		unit_id: identifierSchema,
		finding_id: identifierSchema,
	})
	.strict();

const rawAggregationModelOutputSchema = z
	.object({
		overall_summary: nonEmptyStringSchema,
		ordered_groups: z.array(
			z
				.object({
					finding_refs: z.array(rawFindingReferenceSchema).min(1),
					title: nonEmptyStringSchema,
					reason: nonEmptyStringSchema,
					recommended_action: nonEmptyStringSchema,
					verification_after_change: nonEmptyStringSchema,
				})
				.strict(),
		),
		coverage_gaps: z.array(
			z
				.object({
					unit_id: identifierSchema,
					path: absolutePathStringSchema,
					reason: nonEmptyStringSchema,
				})
				.strict(),
		),
	})
	.strict();

type RawPlannerOutput = z.infer<typeof rawPlannerOutputSchema>;
type RawReviewerOutput = z.infer<typeof rawReviewerOutputSchema>;
type RawAggregationModelOutput = z.infer<typeof rawAggregationModelOutputSchema>;

/** PromptRunner-facing Zod schema for planner yields (snake_case model DTO). */
export function plannerOutputSchema(): z.ZodType<RawPlannerOutput> {
	return rawPlannerOutputSchema;
}

/** PromptRunner-facing Zod schema for reviewer yields (snake_case model DTO). */
export function reviewerOutputSchema(): z.ZodType<RawReviewerOutput> {
	return rawReviewerOutputSchema;
}

/** PromptRunner-facing Zod schema for aggregator yields (snake_case model DTO). */
export function aggregationModelOutputSchema(): z.ZodType<RawAggregationModelOutput> {
	return rawAggregationModelOutputSchema;
}

/** Assignment alias for PromptRunner aggregator schema. */
export function aggregationOutputSchema(): z.ZodType<RawAggregationModelOutput> {
	return aggregationModelOutputSchema();
}

function ok<T>(value: T): ReviewOutcome<T> {
	return { ok: true, value };
}

function fail<T>(failure: ReviewFailure): ReviewOutcome<T> {
	return { ok: false, failure };
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(resolve(root), resolve(candidate));
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function normalizeAbsolutePath(cwd: string, pathValue: string): string {
	return resolve(cwd, pathValue);
}

function pathAllowed(roots: string[], absolutePath: string): boolean {
	return roots.some(root => isWithin(root, absolutePath));
}

function findingReferenceKey(unitId: string, findingId: string): string {
	return `${unitId}/${findingId}`;
}

function samePathSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	if (rightSet.size !== right.length) return false;
	return left.every(pathValue => rightSet.has(pathValue));
}

function zodMessage(error: z.ZodError): string {
	return error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map(key => [key, sortKeysDeep(record[key])]),
		);
	}
	return value;
}

function canonicalString(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value));
}

/** Unit fingerprint covers every semantic ReviewUnit field. */
function unitFingerprintPayload(unit: ReviewUnit) {
	return {
		id: unit.id,
		title: unit.title,
		objective: unit.objective,
		primaryFiles: unit.primaryFiles,
		relatedFiles: unit.relatedFiles,
		reviewFocus: unit.reviewFocus,
		riskLevel: unit.riskLevel,
		rationale: unit.rationale,
	};
}

/** Plan fingerprint payload excludes createdAt and plannerExecution. */
function planFingerprintPayload(
	artifact: Pick<
		PlanArtifact,
		"schemaVersion" | "promptVersion" | "reviewGoal" | "riskLevel" | "targetFiles" | "sourceFingerprint" | "units"
	>,
) {
	return {
		schemaVersion: artifact.schemaVersion,
		promptVersion: artifact.promptVersion,
		reviewGoal: artifact.reviewGoal,
		riskLevel: artifact.riskLevel,
		targetFiles: [...artifact.targetFiles].sort((left, right) => left.localeCompare(right)),
		sourceFingerprint: artifact.sourceFingerprint,
		units: artifact.units.map(unitFingerprintPayload),
	};
}

function hashCanonical(hash: HashFn, value: unknown): string {
	return hash(canonicalString(value));
}

function canonicalizeReviewUnit(raw: z.infer<typeof rawReviewUnitSchema>, cwd: string): ReviewUnit {
	return {
		id: raw.id,
		title: raw.title,
		objective: raw.objective,
		primaryFiles: raw.primary_files.map(pathValue => normalizeAbsolutePath(cwd, pathValue)),
		relatedFiles: raw.related_files.map(pathValue => normalizeAbsolutePath(cwd, pathValue)),
		reviewFocus: [...raw.review_focus],
		riskLevel: raw.risk_level,
		rationale: raw.rationale,
	};
}

function validateUnitsAgainstTargets(
	units: ReviewUnit[],
	targetFiles: string[],
	roots: string[],
): ReviewOutcome<ReviewUnit[]> {
	const targetPaths = new Set(targetFiles.map(pathValue => resolve(pathValue)));
	const unitIds = new Set<string>();
	const primaryCounts = new Map<string, number>();
	const normalizedUnits: ReviewUnit[] = [];

	for (const unit of units) {
		if (unitIds.has(unit.id)) {
			return fail({
				kind: "invalid_plan",
				reason: "duplicate_unit",
				message: `Duplicate unit id: ${unit.id}`,
				target: unit.id,
			});
		}
		unitIds.add(unit.id);

		if (new Set(unit.primaryFiles).size !== unit.primaryFiles.length) {
			return fail({
				kind: "invalid_plan",
				reason: "path",
				message: `Unit ${unit.id} repeats a primary file`,
				target: unit.id,
			});
		}

		for (const primary of unit.primaryFiles) {
			if (!targetPaths.has(primary)) {
				return fail({
					kind: "invalid_plan",
					reason: "unknown_target",
					message: `Unit ${unit.id} owns an unknown target: ${primary}`,
					target: primary,
				});
			}
			if (!pathAllowed(roots, primary)) {
				return fail({
					kind: "invalid_plan",
					reason: "path",
					message: `Unit ${unit.id} primary file is outside review roots: ${primary}`,
					target: primary,
				});
			}
			primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
		}

		const relatedFiles = [...new Set(unit.relatedFiles)];
		for (const related of relatedFiles) {
			if (!pathAllowed(roots, related)) {
				return fail({
					kind: "invalid_plan",
					reason: "path",
					message: `Unit ${unit.id} references a path outside review roots: ${related}`,
					target: related,
				});
			}
		}

		normalizedUnits.push({ ...unit, relatedFiles });
	}

	for (const target of targetPaths) {
		const count = primaryCounts.get(target) ?? 0;
		if (count !== 1) {
			return fail({
				kind: "invalid_plan",
				reason: "ownership",
				message: `Review target must have exactly one primary owner (${count}): ${target}`,
				target,
			});
		}
	}

	return ok(normalizedUnits);
}

function canonicalizeReviewerOutput(raw: RawReviewerOutput, cwd: string): ReviewerOutput {
	return {
		unitId: raw.unit_id,
		verdict: raw.verdict,
		summary: raw.summary,
		findings: raw.findings.map(finding => ({
			id: finding.id,
			title: finding.title,
			category: finding.category,
			severity: finding.severity,
			confidence: finding.confidence,
			evidence: finding.evidence.map(item => ({
				sourceId: normalizeAbsolutePath(cwd, item.source_id),
				startLine: item.start_line,
				endLine: item.end_line,
				quote: item.quote.replace(/\r\n/g, "\n"),
				observation: item.observation,
			})),
			reason: finding.reason,
			suggestedAction: finding.suggested_action,
			verificationAfterChange: finding.verification_after_change,
		})),
		coverage: raw.coverage.map(item => ({
			path: normalizeAbsolutePath(cwd, item.path),
			status: item.status,
			notes: item.notes,
		})),
	};
}

function canonicalizeAggregationModelOutput(raw: RawAggregationModelOutput, cwd: string): AggregationModelOutput {
	return {
		overallSummary: raw.overall_summary,
		orderedGroups: raw.ordered_groups.map(group => ({
			findingRefs: group.finding_refs.map(reference => ({
				unitId: reference.unit_id,
				findingId: reference.finding_id,
			})),
			title: group.title,
			reason: group.reason,
			recommendedAction: group.recommended_action,
			verificationAfterChange: group.verification_after_change,
		})),
		coverageGaps: raw.coverage_gaps.map(gap => ({
			unitId: gap.unit_id,
			path: normalizeAbsolutePath(cwd, gap.path),
			reason: gap.reason,
		})),
	};
}

function validateAggregationGrouping(
	output: AggregationModelOutput,
	plan: ValidatedPlan,
	knownFindingRefs: Set<string>,
): ReviewOutcome<AggregationModelOutput> {
	const knownUnits = new Map(plan.units.map(unit => [unit.id, unit]));
	const seenRefs = new Set<string>();

	for (const group of output.orderedGroups) {
		if (group.findingRefs.length === 0) {
			return fail({
				kind: "invalid_aggregation",
				reason: "invalid_group",
				message: `Aggregator group "${group.title}" has no finding refs`,
			});
		}
		for (const reference of group.findingRefs) {
			const key = findingReferenceKey(reference.unitId, reference.findingId);
			if (!knownFindingRefs.has(key)) {
				return fail({
					kind: "invalid_aggregation",
					reason: "unknown_finding",
					message: `Aggregator referenced unknown finding: ${key}`,
					findingRef: key,
				});
			}
			if (seenRefs.has(key)) {
				return fail({
					kind: "invalid_aggregation",
					reason: "duplicate_finding",
					message: `Aggregator repeated finding: ${key}`,
					findingRef: key,
				});
			}
			seenRefs.add(key);
		}
	}

	for (const key of knownFindingRefs) {
		if (!seenRefs.has(key)) {
			return fail({
				kind: "invalid_aggregation",
				reason: "omitted_finding",
				message: `Aggregator omitted finding: ${key}`,
				findingRef: key,
			});
		}
	}

	for (const gap of output.coverageGaps) {
		const unit = knownUnits.get(gap.unitId);
		if (!unit) {
			return fail({
				kind: "invalid_aggregation",
				reason: "invalid_group",
				message: `Aggregator referenced unknown unit gap: ${gap.unitId}`,
			});
		}
		if (!unit.primaryFiles.includes(gap.path)) {
			return fail({
				kind: "invalid_aggregation",
				reason: "invalid_group",
				message: `Aggregator referenced unknown unit path: ${gap.path}`,
			});
		}
	}

	return ok(output);
}

export function parsePlannerOutput(raw: unknown, context: PlannerOutputParseContext): ReviewOutcome<PlannerOutput> {
	const parsed = rawPlannerOutputSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: zodMessage(parsed.error),
		});
	}

	const roots = context.roots.map(root => resolve(root));
	const targetFiles = context.targetFiles.map(pathValue => normalizeAbsolutePath(context.cwd, pathValue));
	const units = parsed.data.units.map(unit => canonicalizeReviewUnit(unit, context.cwd));
	const validatedUnits = validateUnitsAgainstTargets(units, targetFiles, roots);
	if (!validatedUnits.ok) return validatedUnits;

	return ok({
		overview: parsed.data.overview,
		units: validatedUnits.value,
	});
}

export function parsePlanArtifact(raw: unknown, context: PlanArtifactParseContext): ReviewOutcome<ValidatedPlan> {
	const parsed = planArtifactSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: zodMessage(parsed.error),
		});
	}

	const roots = context.roots.map(root => resolve(root));
	const expectedTargets = context.targetFiles.map(pathValue => normalizeAbsolutePath(context.cwd, pathValue));
	const artifactTargets = parsed.data.targetFiles.map(pathValue => normalizeAbsolutePath(context.cwd, pathValue));

	if (parsed.data.sourceFingerprint !== context.sourceFingerprint) {
		return fail({
			kind: "invalid_plan",
			reason: "stale_sources",
			message: "Plan artifact is stale because its sourceFingerprint does not match current sources",
		});
	}

	if (!samePathSet(expectedTargets, artifactTargets)) {
		return fail({
			kind: "invalid_plan",
			reason: "ownership",
			message: "Plan artifact targetFiles do not match the current review targets",
		});
	}

	const units: ReviewUnit[] = parsed.data.units.map(unit => ({
		...unit,
		primaryFiles: unit.primaryFiles.map(pathValue => normalizeAbsolutePath(context.cwd, pathValue)),
		relatedFiles: [...new Set(unit.relatedFiles.map(pathValue => normalizeAbsolutePath(context.cwd, pathValue)))],
		reviewFocus: [...unit.reviewFocus],
	}));

	const validatedUnits = validateUnitsAgainstTargets(units, artifactTargets, roots);
	if (!validatedUnits.ok) return validatedUnits;

	const sortedTargets = [...artifactTargets].sort((left, right) => left.localeCompare(right));
	const planArtifact: PlanArtifact = {
		schemaVersion: parsed.data.schemaVersion,
		promptVersion: parsed.data.promptVersion,
		reviewGoal: parsed.data.reviewGoal,
		riskLevel: parsed.data.riskLevel,
		targetFiles: sortedTargets,
		sourceFingerprint: parsed.data.sourceFingerprint,
		units: validatedUnits.value,
		createdAt: parsed.data.createdAt,
		plannerExecution: parsed.data.plannerExecution,
	};

	const fingerprintedUnits: ValidatedReviewUnit[] = planArtifact.units.map(unit => ({
		...unit,
		unitFingerprint: hashCanonical(context.hash, unitFingerprintPayload(unit)),
	}));

	return ok({
		...planArtifact,
		units: fingerprintedUnits,
		planFingerprint: hashCanonical(context.hash, planFingerprintPayload(planArtifact)),
	});
}

export function parseReviewerOutput(raw: unknown, context: ReviewerOutputParseContext): ReviewOutcome<ReviewerOutput> {
	const expectedUnitId = context.unit.id;
	const parsed = rawReviewerOutputSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_unit_result",
			reason: "schema",
			unitId: expectedUnitId,
			message: zodMessage(parsed.error),
		});
	}

	const review = canonicalizeReviewerOutput(parsed.data, context.cwd);
	if (review.unitId !== expectedUnitId) {
		return fail({
			kind: "invalid_unit_result",
			reason: "unknown_unit",
			unitId: review.unitId,
			message: `Reviewer returned unit ${review.unitId} for ${expectedUnitId}`,
		});
	}

	const findingIds = new Set<string>();
	for (const finding of review.findings) {
		if (findingIds.has(finding.id)) {
			return fail({
				kind: "invalid_unit_result",
				reason: "schema",
				unitId: expectedUnitId,
				message: `Unit ${expectedUnitId} repeats finding id ${finding.id}`,
			});
		}
		findingIds.add(finding.id);
	}

	return ok(review);
}

export function parseUnitReviewArtifact(
	raw: unknown,
	context: UnitReviewArtifactParseContext,
): ReviewOutcome<UnitReviewArtifact> {
	const parsed = unitReviewArtifactSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_unit_result",
			reason: "schema",
			message: zodMessage(parsed.error),
		});
	}

	const artifact = parsed.data;
	if (artifact.planFingerprint !== context.plan.planFingerprint) {
		return fail({
			kind: "invalid_unit_result",
			reason: "foreign_plan",
			unitId: artifact.unitId,
			message: "Unit review artifact planFingerprint does not match the active plan",
		});
	}

	const planUnit = context.plan.units.find(unit => unit.id === artifact.unitId);
	if (!planUnit) {
		return fail({
			kind: "invalid_unit_result",
			reason: "unknown_unit",
			unitId: artifact.unitId,
			message: `Unit review artifact references unknown unit: ${artifact.unitId}`,
		});
	}

	if (artifact.unitFingerprint !== planUnit.unitFingerprint) {
		return fail({
			kind: "invalid_unit_result",
			reason: "stale_unit",
			unitId: artifact.unitId,
			message: `Unit review artifact is stale for unit: ${artifact.unitId}`,
		});
	}

	const seenSeed = new Set(context.seenUnitIds ?? []);
	if (seenSeed.has(artifact.unitId)) {
		return fail({
			kind: "invalid_unit_result",
			reason: "duplicate_unit",
			unitId: artifact.unitId,
			message: `Duplicate unit review artifact for unit: ${artifact.unitId}`,
		});
	}

	if (artifact.status === "succeeded") {
		if (artifact.review.unitId !== artifact.unitId) {
			return fail({
				kind: "invalid_unit_result",
				reason: "schema",
				unitId: artifact.unitId,
				message: `Succeeded unit artifact review.unitId ${artifact.review.unitId} does not match unitId`,
			});
		}

		return ok({
			...artifact,
			review: {
				...artifact.review,
				coverage: artifact.review.coverage.map(item => ({
					...item,
					path: normalizeAbsolutePath(context.cwd, item.path),
				})),
				findings: artifact.review.findings.map(finding => ({
					...finding,
					evidence: finding.evidence.map(item => ({
						...item,
						sourceId: normalizeAbsolutePath(context.cwd, item.sourceId),
						quote: item.quote.replace(/\r\n/g, "\n"),
					})),
				})),
			},
		});
	}

	return ok(artifact);
}

export function parseAggregationModelOutput(
	raw: unknown,
	context: AggregationModelOutputParseContext,
): ReviewOutcome<AggregationModelOutput> {
	const parsed = rawAggregationModelOutputSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_aggregation",
			reason: "invalid_group",
			message: zodMessage(parsed.error),
		});
	}

	const knownFindingRefs = new Set(context.knownFindingRefs);
	if (knownFindingRefs.size === 0 && parsed.data.ordered_groups.length > 0) {
		return fail({
			kind: "invalid_aggregation",
			reason: "missing_results",
			message: "Aggregator produced finding groups but no unit findings are available",
		});
	}

	const canonical = canonicalizeAggregationModelOutput(parsed.data, context.cwd);
	return validateAggregationGrouping(canonical, context.plan, knownFindingRefs);
}

/** Assignment alias for aggregator output parsing. */
export function parseAggregationOutput(
	raw: unknown,
	context: AggregationModelOutputParseContext,
): ReviewOutcome<AggregationModelOutput> {
	return parseAggregationModelOutput(raw, context);
}

export function parseRiskLevel(raw: unknown): ReviewOutcome<RiskLevel> {
	const parsed = riskLevelSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: `Invalid risk level: ${String(raw)}`,
		});
	}
	return ok(parsed.data);
}

function takeFlagValue(args: string[], flag: string, index: number): ReviewOutcome<string> {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: `Missing required ${flag} value`,
		});
	}
	return ok(value);
}

function parseUnitIdList(raw: string): ReviewOutcome<string[]> {
	const unitIds = raw
		.split(",")
		.map(part => part.trim())
		.filter(Boolean);
	if (unitIds.length === 0) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: "Expected at least one unit id",
		});
	}
	const seen = new Set<string>();
	for (const unitId of unitIds) {
		const parsed = identifierSchema.safeParse(unitId);
		if (!parsed.success) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: `Invalid unit id: ${unitId}`,
				target: unitId,
			});
		}
		if (seen.has(unitId)) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: `Duplicate unit id selection: ${unitId}`,
				target: unitId,
			});
		}
		seen.add(unitId);
	}
	return ok(unitIds);
}

/**
 * Parse CLI argv into a typed command.
 * Paths are resolved to absolute paths; selected unit IDs are validated once.
 *
 * ```
 * plan --goal <goal> [--risk <level>] --output <plan.json> -- <file>...
 * review-unit --plan <plan.json> --unit <id> --output <unit.json>
 * review-units --plan <plan.json> --output-dir <dir> (--units id1,id2 | --unit id)...
 * aggregate --plan <plan.json> --results-dir <dir> --output <report.json>
 * run --goal <goal> [--risk <level>] [--output <report.json>] -- <file>...
 * ```
 */
export function parseCliCommand(rawArgs: string[]): ReviewOutcome<CliCommand> {
	const cwd = process.cwd();
	const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];

	let command: CliCommand["command"] | undefined;
	let reviewGoal: string | undefined;
	let riskLevel: RiskLevel = "medium";
	let outputPath: string | undefined;
	let outputDir: string | undefined;
	let planPath: string | undefined;
	let resultsDir: string | undefined;
	let unitId: string | undefined;
	const unitIds: string[] = [];
	const positional: string[] = [];

	for (let index = 0; index < args.length; ) {
		const arg = args[index];

		if (arg === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}

		if (
			!command &&
			(arg === "plan" || arg === "review-unit" || arg === "review-units" || arg === "aggregate" || arg === "run")
		) {
			command = arg;
			index += 1;
			continue;
		}

		if (arg === "--command") {
			const value = takeFlagValue(args, "--command", index);
			if (!value.ok) return value;
			if (
				value.value !== "plan" &&
				value.value !== "review-unit" &&
				value.value !== "review-units" &&
				value.value !== "aggregate" &&
				value.value !== "run"
			) {
				return fail({
					kind: "invalid_plan",
					reason: "schema",
					message: `Unknown command: ${value.value}`,
				});
			}
			command = value.value;
			index += 2;
			continue;
		}

		if (arg === "--goal") {
			const value = takeFlagValue(args, "--goal", index);
			if (!value.ok) return value;
			reviewGoal = value.value;
			index += 2;
			continue;
		}

		if (arg === "--risk" || arg === "--risk-level") {
			const value = takeFlagValue(args, arg, index);
			if (!value.ok) return value;
			const parsedRisk = parseRiskLevel(value.value);
			if (!parsedRisk.ok) return parsedRisk;
			riskLevel = parsedRisk.value;
			index += 2;
			continue;
		}

		if (arg === "--output") {
			const value = takeFlagValue(args, "--output", index);
			if (!value.ok) return value;
			outputPath = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--output-dir") {
			const value = takeFlagValue(args, "--output-dir", index);
			if (!value.ok) return value;
			outputDir = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--plan") {
			const value = takeFlagValue(args, "--plan", index);
			if (!value.ok) return value;
			planPath = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--results-dir") {
			const value = takeFlagValue(args, "--results-dir", index);
			if (!value.ok) return value;
			resultsDir = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--unit") {
			const value = takeFlagValue(args, "--unit", index);
			if (!value.ok) return value;
			const parsed = identifierSchema.safeParse(value.value);
			if (!parsed.success) {
				return fail({
					kind: "invalid_plan",
					reason: "schema",
					message: `Invalid unit id: ${value.value}`,
					target: value.value,
				});
			}
			if (unitId !== undefined || unitIds.includes(value.value)) {
				return fail({
					kind: "invalid_plan",
					reason: "schema",
					message: `Duplicate unit id selection: ${value.value}`,
					target: value.value,
				});
			}
			unitId = value.value;
			unitIds.push(value.value);
			index += 2;
			continue;
		}

		if (arg === "--units") {
			const value = takeFlagValue(args, "--units", index);
			if (!value.ok) return value;
			const parsed = parseUnitIdList(value.value);
			if (!parsed.ok) return parsed;
			for (const id of parsed.value) {
				if (unitIds.includes(id)) {
					return fail({
						kind: "invalid_plan",
						reason: "schema",
						message: `Duplicate unit id selection: ${id}`,
						target: id,
					});
				}
				unitIds.push(id);
			}
			if (unitId === undefined && parsed.value.length === 1) unitId = parsed.value[0];
			index += 2;
			continue;
		}

		if (arg.startsWith("--")) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: `Unknown flag: ${arg}`,
			});
		}

		positional.push(arg);
		index += 1;
	}

	const selectedCommand = command ?? "run";

	if (selectedCommand === "review-unit") {
		if (!planPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --plan value for review-unit",
			});
		}
		if (!unitId || unitIds.length !== 1) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "review-unit requires exactly one --unit <id>",
			});
		}
		if (!outputPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --output value for review-unit",
			});
		}
		return ok({
			command: "review-unit",
			planPath,
			unitId,
			outputPath,
		});
	}

	if (selectedCommand === "review-units") {
		if (!planPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --plan value for review-units",
			});
		}
		if (!outputDir) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --output-dir value for review-units",
			});
		}
		if (unitIds.length === 0) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "review-units requires explicit unit ids via --unit/--units",
			});
		}
		return ok({
			command: "review-units",
			planPath,
			unitIds: [...unitIds],
			outputDir,
		});
	}

	if (selectedCommand === "aggregate") {
		if (!planPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --plan value for aggregate",
			});
		}
		if (!resultsDir) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --results-dir value for aggregate",
			});
		}
		if (!outputPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --output value for aggregate",
			});
		}
		return ok({
			command: "aggregate",
			planPath,
			resultsDir,
			outputPath,
		});
	}

	const goal = reviewGoal ?? positional[0];
	const filePaths = reviewGoal ? positional : positional.slice(1);
	if (!goal || filePaths.length === 0) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: "Usage requires --goal <review-goal> and at least one target file",
		});
	}

	const targetFiles = filePaths.map(pathValue => normalizeAbsolutePath(cwd, pathValue));
	const uniqueTargets = new Set(targetFiles);
	if (uniqueTargets.size !== targetFiles.length) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: "Duplicate review target paths",
		});
	}

	if (selectedCommand === "plan") {
		if (!outputPath) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: "Missing required --output value for plan",
			});
		}
		return ok({
			command: "plan",
			reviewGoal: goal,
			riskLevel,
			targetFiles,
			outputPath,
		});
	}

	return ok({
		command: "run",
		reviewGoal: goal,
		riskLevel,
		targetFiles,
		...(outputPath ? { outputPath } : {}),
	});
}

/** Build a plan artifact (no computed fingerprints). Runner supplies sourceFingerprint. */
export function toPlanArtifact(input: {
	reviewGoal: string;
	riskLevel: RiskLevel;
	targetFiles: string[];
	sourceFingerprint: string;
	units: ReviewUnit[];
	createdAt: string;
	plannerExecution: PromptExecutionMetadata;
}): PlanArtifact {
	const targetFiles = [...new Set(input.targetFiles.map(pathValue => resolve(pathValue)))].sort((left, right) =>
		left.localeCompare(right),
	);
	return {
		schemaVersion: PLAN_SCHEMA_VERSION,
		promptVersion: PROMPT_VERSION,
		reviewGoal: input.reviewGoal,
		riskLevel: input.riskLevel,
		targetFiles,
		sourceFingerprint: input.sourceFingerprint,
		units: input.units.map(unit => ({
			...unit,
			primaryFiles: unit.primaryFiles.map(pathValue => resolve(pathValue)),
			relatedFiles: [...new Set(unit.relatedFiles.map(pathValue => resolve(pathValue)))],
			reviewFocus: [...unit.reviewFocus],
		})),
		createdAt: input.createdAt,
		plannerExecution: input.plannerExecution,
	};
}

/** Attach computed fingerprints to a trusted plan artifact. */
export function toValidatedPlan(artifact: PlanArtifact, hash: HashFn): ValidatedPlan {
	const normalized: PlanArtifact = {
		...artifact,
		targetFiles: [...artifact.targetFiles].sort((left, right) => left.localeCompare(right)),
		units: artifact.units.map(unit => ({
			...unit,
			primaryFiles: [...unit.primaryFiles],
			relatedFiles: [...new Set(unit.relatedFiles)],
			reviewFocus: [...unit.reviewFocus],
		})),
	};
	const units: ValidatedReviewUnit[] = normalized.units.map(unit => ({
		...unit,
		unitFingerprint: hashCanonical(hash, unitFingerprintPayload(unit)),
	}));
	return {
		...normalized,
		units,
		planFingerprint: hashCanonical(hash, planFingerprintPayload(normalized)),
	};
}

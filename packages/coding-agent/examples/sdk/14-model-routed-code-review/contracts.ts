import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";
import type { ContextToolMode } from "./context-tools";

/** Stable versions shared by plan/unit/report artifacts and prompt metadata. */
export const PROMPT_VERSION = "filesystem-model-routed-review/2.0.0" as const;
export const PLAN_SCHEMA_VERSION = "review-plan/1.0.0" as const;
export const UNIT_REVIEW_SCHEMA_VERSION = "unit-review/2.0.0" as const;
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
const isoDateTimeSchema = z.iso.datetime({ offset: true });
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
			kind: "source_snapshot_failed";
			stage: PromptStage;
			unitId?: string;
			message: string;
	  }
	| {
			kind: "artifact_io_failed";
			operation: "read" | "write" | "publish";
			path: string;
			message: string;
	  }
	| {
			kind: "invalid_artifact";
			artifact: "plan" | "unit_review";
			reason: "json";
			path: string;
			message: string;
	  }
	| {
			kind: "runtime_failed";
			stage: "initialization" | "cli";
			message: string;
	  }
	| {
			kind: "invalid_cli";
			message: string;
			argument?: string;
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
			reason:
				| "schema"
				| "unknown_unit"
				| "duplicate_unit"
				| "foreign_plan"
				| "stale_unit"
				| "stale_sources"
				| "non_terminal";
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
			sourceFingerprint: string;
			status: "succeeded";
			review: VerifiedUnitReview;
			execution: PromptExecutionMetadata;
	  }
	| {
			schemaVersion: typeof UNIT_REVIEW_SCHEMA_VERSION;
			planFingerprint: string;
			unitId: string;
			unitFingerprint: string;
			sourceFingerprint?: string;
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
			kind: z.literal("source_snapshot_failed"),
			stage: promptStageSchema,
			unitId: identifierSchema.optional(),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("artifact_io_failed"),
			operation: z.enum(["read", "write", "publish"]),
			path: absolutePathStringSchema,
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_artifact"),
			artifact: z.enum(["plan", "unit_review"]),
			reason: z.literal("json"),
			path: absolutePathStringSchema,
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("runtime_failed"),
			stage: z.enum(["initialization", "cli"]),
			message: nonEmptyStringSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("invalid_cli"),
			message: nonEmptyStringSchema,
			argument: nonEmptyStringSchema.optional(),
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
			reason: z.enum([
				"schema",
				"unknown_unit",
				"duplicate_unit",
				"foreign_plan",
				"stale_unit",
				"stale_sources",
				"non_terminal",
			]),
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
			sourceFingerprint: fingerprintSchema,
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
			sourceFingerprint: fingerprintSchema.optional(),
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

export type RawPlannerOutput = z.infer<typeof rawPlannerOutputSchema>;
export type RawReviewerOutput = z.infer<typeof rawReviewerOutputSchema>;
export type RawAggregationModelOutput = z.infer<typeof rawAggregationModelOutputSchema>;

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

export function planArtifactBoundarySchema(): z.ZodType<PlanArtifact> {
	return planArtifactSchema;
}

export function unitReviewArtifactBoundarySchema(): z.ZodType<UnitReviewArtifact> {
	return unitReviewArtifactSchema;
}

export function riskLevelBoundarySchema(): z.ZodType<RiskLevel> {
	return riskLevelSchema;
}

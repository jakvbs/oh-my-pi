import { isAbsolute, relative, resolve } from "node:path";
import type { z } from "zod";
import {
	type AggregationModelOutput,
	type AggregationModelOutputParseContext,
	aggregationModelOutputSchema,
	type HashFn,
	PLAN_SCHEMA_VERSION,
	type PlanArtifact,
	type PlanArtifactParseContext,
	type PlannerOutput,
	type PlannerOutputParseContext,
	PROMPT_VERSION,
	type PromptExecutionMetadata,
	planArtifactBoundarySchema,
	plannerOutputSchema,
	type RawAggregationModelOutput,
	type RawPlannerOutput,
	type RawReviewerOutput,
	type ReviewerOutput,
	type ReviewerOutputParseContext,
	type ReviewFailure,
	type ReviewOutcome,
	type ReviewUnit,
	type RiskLevel,
	reviewerOutputSchema,
	type UnitReviewArtifact,
	type UnitReviewArtifactParseContext,
	unitReviewArtifactBoundarySchema,
	type ValidatedPlan,
	type ValidatedReviewUnit,
} from "./contracts";
import {
	planFingerprintInput,
	unitFingerprintInput,
	validateAggregationGrouping,
	validateTargetOwnership,
	validateUniqueUnitIds,
} from "./review-policy";

const rawPlannerOutputSchema = plannerOutputSchema();
const rawReviewerOutputSchema = reviewerOutputSchema();
const rawAggregationModelOutputSchema = aggregationModelOutputSchema();
const planArtifactSchema = planArtifactBoundarySchema();
const unitReviewArtifactSchema = unitReviewArtifactBoundarySchema();

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

function hashCanonical(hash: HashFn, value: unknown): string {
	return hash(canonicalString(value));
}

function canonicalizeReviewUnit(raw: RawPlannerOutput["units"][number], cwd: string): ReviewUnit {
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
	const normalizedUnits: ReviewUnit[] = [];
	for (const unit of units) {
		for (const primary of unit.primaryFiles) {
			if (!pathAllowed(roots, primary)) {
				return fail({
					kind: "invalid_plan",
					reason: "path",
					message: `Unit ${unit.id} primary file is outside review roots: ${primary}`,
					target: primary,
				});
			}
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
	const uniqueIds = validateUniqueUnitIds(normalizedUnits);
	if (!uniqueIds.ok) return uniqueIds;
	const ownership = validateTargetOwnership(
		normalizedUnits,
		targetFiles.map(pathValue => resolve(pathValue)),
	);
	if (!ownership.ok) return ownership;
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
		unitFingerprint: hashCanonical(context.hash, unitFingerprintInput(unit)),
	}));

	return ok({
		...planArtifact,
		units: fingerprintedUnits,
		planFingerprint: hashCanonical(context.hash, planFingerprintInput(planArtifact)),
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
		unitFingerprint: hashCanonical(hash, unitFingerprintInput(unit)),
	}));
	return {
		...normalized,
		units,
		planFingerprint: hashCanonical(hash, planFingerprintInput(normalized)),
	};
}

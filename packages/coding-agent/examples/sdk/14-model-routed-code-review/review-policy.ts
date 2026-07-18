import type {
	AggregatedFinding,
	AggregationModelOutput,
	Confidence,
	CoverageItem,
	Evidence,
	Finding,
	ReviewerOutput,
	ReviewFailure,
	ReviewOutcome,
	ReviewRunState,
	ReviewUnit,
	Severity,
	UnitReviewArtifact,
	ValidatedPlan,
	ValidatedReviewUnit,
	Verdict,
	VerifiedEvidence,
	VerifiedFinding,
} from "./contracts";

type PlanFingerprintSource = {
	schemaVersion: string;
	promptVersion: string;
	reviewGoal: string;
	riskLevel: string;
	targetFiles: readonly string[];
	sourceFingerprint: string;
	units: readonly ReviewUnit[];
};

export type SourceSnapshot = {
	sourceId: string;
	content: string;
	wasRead: boolean;
};

export type UnitFingerprintInput = {
	id: string;
	title: string;
	objective: string;
	primaryFiles: string[];
	relatedFiles: string[];
	reviewFocus: string[];
	riskLevel: string;
	rationale: string;
};

export type PlanFingerprintInput = {
	schemaVersion: string;
	promptVersion: string;
	reviewGoal: string;
	riskLevel: string;
	targetFiles: string[];
	sourceFingerprint: string;
	units: UnitFingerprintInput[];
};

const SEVERITY_RANK: Record<Severity, number> = {
	heuristic: 0,
	minor: 1,
	major: 2,
	critical: 3,
};

const CONFIDENCE_RANK: Record<Confidence, number> = {
	low: 0,
	medium: 1,
	high: 2,
};

function ok<T>(value: T): ReviewOutcome<T> {
	return { ok: true, value };
}

function fail<T>(failure: ReviewFailure): ReviewOutcome<T> {
	return { ok: false, failure };
}

function findingReferenceKey(unitId: string, findingId: string): string {
	return `${unitId}/${findingId}`;
}

function hasSeriousFinding(findings: readonly { severity: Severity }[]): boolean {
	return findings.some(finding => finding.severity === "major" || finding.severity === "critical");
}

function knownFindingRefs(unitResults: readonly UnitReviewArtifact[]): Set<string> {
	const refs = new Set<string>();
	for (const artifact of unitResults) {
		if (artifact.status !== "succeeded") continue;
		for (const finding of artifact.review.findings) {
			refs.add(findingReferenceKey(artifact.unitId, finding.id));
		}
	}
	return refs;
}

function planUnitById(plan: ValidatedPlan): Map<string, ValidatedReviewUnit> {
	return new Map(plan.units.map(unit => [unit.id, unit]));
}

/** Exactly one primary owner per review target. */
export function validateTargetOwnership(
	units: readonly ReviewUnit[],
	targetFiles: readonly string[],
): ReviewOutcome<true> {
	const targetPaths = new Set(targetFiles);
	const primaryCounts = new Map<string, number>();

	for (const unit of units) {
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
			primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
		}
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

	return ok(true);
}

/** Unit ids must be unique within a plan. */
export function validateUniqueUnitIds(units: readonly ReviewUnit[]): ReviewOutcome<true> {
	const seen = new Set<string>();
	for (const unit of units) {
		if (seen.has(unit.id)) {
			return fail({
				kind: "invalid_plan",
				reason: "duplicate_unit",
				message: `Duplicate unit id: ${unit.id}`,
				target: unit.id,
			});
		}
		seen.add(unit.id);
	}
	return ok(true);
}

/** Selected unit ids must be known to the plan and contain no duplicates. */
export function validateUnitSelection(
	plan: ValidatedPlan,
	selectedUnitIds: readonly string[],
): ReviewOutcome<readonly string[]> {
	const known = new Set(plan.units.map(unit => unit.id));
	const seen = new Set<string>();
	const selected: string[] = [];

	for (const unitId of selectedUnitIds) {
		if (!known.has(unitId)) {
			return fail({
				kind: "invalid_unit_result",
				reason: "unknown_unit",
				unitId,
				message: `Unknown unit id selected: ${unitId}`,
			});
		}
		if (seen.has(unitId)) {
			return fail({
				kind: "invalid_unit_result",
				reason: "duplicate_unit",
				unitId,
				message: `Duplicate unit id selected: ${unitId}`,
			});
		}
		seen.add(unitId);
		selected.push(unitId);
	}

	return ok(selected);
}

/**
 * Canonical semantic unit fingerprint input.
 * Excludes computed fingerprints and other volatile metadata.
 */
export function unitFingerprintInput(unit: ReviewUnit): UnitFingerprintInput {
	return {
		id: unit.id,
		title: unit.title,
		objective: unit.objective,
		primaryFiles: [...unit.primaryFiles],
		relatedFiles: [...unit.relatedFiles],
		reviewFocus: [...unit.reviewFocus],
		riskLevel: unit.riskLevel,
		rationale: unit.rationale,
	};
}

/**
 * Canonical semantic plan fingerprint input.
 * Excludes createdAt, plannerExecution, and computed fingerprints.
 */
export function planFingerprintInput(planLike: PlanFingerprintSource): PlanFingerprintInput {
	return {
		schemaVersion: planLike.schemaVersion,
		promptVersion: planLike.promptVersion,
		reviewGoal: planLike.reviewGoal,
		riskLevel: planLike.riskLevel,
		targetFiles: [...planLike.targetFiles],
		sourceFingerprint: planLike.sourceFingerprint,
		units: planLike.units.map(unit => unitFingerprintInput(unit)),
	};
}

/** Coverage must list each primary file exactly once; reviewed paths must have been read. */
export function decideReviewerCoverage(input: {
	unit: ReviewUnit;
	coverage: readonly CoverageItem[];
	readPaths: ReadonlySet<string>;
}): ReviewOutcome<{ coverage: CoverageItem[]; hasUnavailable: boolean }> {
	const { unit, coverage, readPaths } = input;
	const byPath = new Map<string, CoverageItem>();

	for (const item of coverage) {
		if (byPath.has(item.path)) {
			return fail({
				kind: "invalid_coverage",
				unitId: unit.id,
				path: item.path,
				message: `Unit ${unit.id} repeats a coverage path`,
			});
		}
		byPath.set(item.path, item);
	}

	if (byPath.size !== unit.primaryFiles.length) {
		return fail({
			kind: "invalid_coverage",
			unitId: unit.id,
			message: `Unit ${unit.id} coverage does not match primary scope`,
		});
	}

	for (const path of unit.primaryFiles) {
		const item = byPath.get(path);
		if (!item) {
			return fail({
				kind: "invalid_coverage",
				unitId: unit.id,
				path,
				message: `Unit ${unit.id} omitted coverage for ${path}`,
			});
		}
		if (item.status === "reviewed" && !readPaths.has(path)) {
			return fail({
				kind: "invalid_coverage",
				unitId: unit.id,
				path,
				message: `Unit ${unit.id} claims unread file as reviewed: ${path}`,
			});
		}
	}

	return ok({
		coverage: unit.primaryFiles.map(path => byPath.get(path)!),
		hasUnavailable: coverage.some(item => item.status === "unavailable"),
	});
}

/** Canonical evidence hash input string (no hashing performed here). */
export function evidenceHashInput(evidence: Pick<Evidence, "sourceId" | "startLine" | "endLine" | "quote">): string {
	return `${evidence.sourceId}:${evidence.startLine}:${evidence.endLine}:${evidence.quote}`;
}

/**
 * Verify finding evidence against provided source snapshots.
 * IO-free: callers supply snapshot content and an injected hash capability.
 */
export function verifyEvidence(input: {
	unitId: string;
	findings: readonly Finding[];
	sourceSnapshots: readonly SourceSnapshot[];
	allowedSourceIds: ReadonlySet<string>;
	hash: (canonical: string) => string;
}): ReviewOutcome<VerifiedFinding[]> {
	const { unitId, findings, sourceSnapshots, allowedSourceIds, hash } = input;
	const snapshots = new Map(sourceSnapshots.map(snapshot => [snapshot.sourceId, snapshot]));
	const verifiedFindings: VerifiedFinding[] = [];
	const findingIds = new Set<string>();

	for (const finding of findings) {
		if (findingIds.has(finding.id)) {
			return fail({
				kind: "invalid_unit_result",
				reason: "schema",
				unitId,
				message: `Unit ${unitId} repeats finding id ${finding.id}`,
			});
		}
		findingIds.add(finding.id);

		const evidence: VerifiedEvidence[] = [];
		for (const item of finding.evidence) {
			if (!allowedSourceIds.has(item.sourceId)) {
				return fail({
					kind: "invalid_evidence",
					unitId,
					findingId: finding.id,
					sourceId: item.sourceId,
					message: `Finding ${finding.id} cites disallowed source: ${item.sourceId}`,
				});
			}

			const snapshot = snapshots.get(item.sourceId);
			if (!snapshot?.wasRead) {
				return fail({
					kind: "invalid_evidence",
					unitId,
					findingId: finding.id,
					sourceId: item.sourceId,
					message: `Finding ${finding.id} cites unread source: ${item.sourceId}`,
				});
			}

			const lines = snapshot.content.split(/\r?\n/);
			if (item.endLine < item.startLine || item.endLine > lines.length) {
				return fail({
					kind: "invalid_evidence",
					unitId,
					findingId: finding.id,
					sourceId: item.sourceId,
					message: `Finding ${finding.id} cites invalid lines in ${item.sourceId}`,
				});
			}

			const quote = lines.slice(item.startLine - 1, item.endLine).join("\n");
			const normalizedQuote = item.quote.replace(/\r\n/g, "\n");
			if (normalizedQuote !== quote) {
				return fail({
					kind: "invalid_evidence",
					unitId,
					findingId: finding.id,
					sourceId: item.sourceId,
					message: `Finding ${finding.id} quote does not match ${item.sourceId}:${item.startLine}-${item.endLine}`,
				});
			}

			const hashInput = evidenceHashInput({
				sourceId: item.sourceId,
				startLine: item.startLine,
				endLine: item.endLine,
				quote,
			});
			evidence.push({
				sourceId: item.sourceId,
				startLine: item.startLine,
				endLine: item.endLine,
				quote,
				observation: item.observation,
				hash: hash(hashInput),
			});
		}

		verifiedFindings.push({ ...finding, evidence });
	}

	return ok(verifiedFindings);
}

/**
 * Unit verdict decision table (precedence):
 * 1) unavailable coverage → INSUFFICIENT_CONTEXT
 * 2) major|critical finding → FAIL
 * 3) any finding → NEEDS_REVIEW
 * 4) else → PASS
 */
export function decideUnitVerdict(input: {
	findings: readonly { severity: Severity }[];
	hasUnavailableCoverage: boolean;
}): Verdict {
	if (input.hasUnavailableCoverage) return "INSUFFICIENT_CONTEXT";
	if (hasSeriousFinding(input.findings)) return "FAIL";
	if (input.findings.length > 0) return "NEEDS_REVIEW";
	return "PASS";
}

/**
 * Overall verdict decision table (precedence):
 * 1) incomplete → INSUFFICIENT_CONTEXT
 * 2) major|critical finding → FAIL
 * 3) any finding → NEEDS_REVIEW
 * 4) else → PASS
 */
export function decideOverallVerdict(input: {
	findings: readonly { severity: Severity }[];
	incomplete: boolean;
}): Verdict {
	if (input.incomplete) return "INSUFFICIENT_CONTEXT";
	if (hasSeriousFinding(input.findings)) return "FAIL";
	if (input.findings.length > 0) return "NEEDS_REVIEW";
	return "PASS";
}

/** Validate claimed reviewer verdict against the unit decision table. */
export function decideReviewerVerdictConsistency(input: {
	unitId: string;
	claimedVerdict: Verdict;
	findings: readonly { severity: Severity }[];
	hasUnavailableCoverage: boolean;
}): ReviewOutcome<Verdict> {
	const expected = decideUnitVerdict({
		findings: input.findings,
		hasUnavailableCoverage: input.hasUnavailableCoverage,
	});
	if (input.claimedVerdict !== expected) {
		return fail({
			kind: "invalid_unit_result",
			reason: "schema",
			unitId: input.unitId,
			message: `Unit ${input.unitId} verdict ${input.claimedVerdict} is inconsistent with evidence (expected ${expected})`,
		});
	}
	return ok(expected);
}

/**
 * Aggregation is ready only when every plan unit has exactly one terminal artifact
 * with matching plan and unit fingerprints.
 */
export function decideAggregationReadiness(
	plan: ValidatedPlan,
	unitResults: readonly UnitReviewArtifact[],
): ReviewOutcome<readonly UnitReviewArtifact[]> {
	const expectedIds = plan.units.map(unit => unit.id);
	const units = planUnitById(plan);
	const byUnitId = new Map<string, UnitReviewArtifact>();

	for (const artifact of unitResults) {
		const unit = units.get(artifact.unitId);
		if (!unit) {
			return fail({
				kind: "invalid_unit_result",
				reason: "unknown_unit",
				unitId: artifact.unitId,
				message: `Unknown unit result: ${artifact.unitId}`,
			});
		}
		if (byUnitId.has(artifact.unitId)) {
			return fail({
				kind: "invalid_unit_result",
				reason: "duplicate_unit",
				unitId: artifact.unitId,
				message: `Duplicate unit result: ${artifact.unitId}`,
			});
		}
		if (artifact.planFingerprint !== plan.planFingerprint) {
			return fail({
				kind: "invalid_unit_result",
				reason: "foreign_plan",
				unitId: artifact.unitId,
				message: `Unit ${artifact.unitId} belongs to a different plan fingerprint`,
			});
		}
		if (artifact.unitFingerprint !== unit.unitFingerprint) {
			return fail({
				kind: "invalid_unit_result",
				reason: "stale_unit",
				unitId: artifact.unitId,
				message: `Unit ${artifact.unitId} fingerprint does not match the validated plan`,
			});
		}
		byUnitId.set(artifact.unitId, artifact);
	}

	if (byUnitId.size !== expectedIds.length) {
		return fail({
			kind: "invalid_aggregation",
			reason: "missing_results",
			message: `Expected ${expectedIds.length} unit results, received ${byUnitId.size}`,
		});
	}

	for (const unitId of expectedIds) {
		if (!byUnitId.has(unitId)) {
			return fail({
				kind: "invalid_aggregation",
				reason: "missing_results",
				message: `Missing unit result for ${unitId}`,
			});
		}
	}

	return ok(expectedIds.map(unitId => byUnitId.get(unitId)!));
}

/** Every succeeded finding reference must appear exactly once across aggregator groups. */
export function validateFindingReferenceConservation(
	output: AggregationModelOutput,
	unitResults: readonly UnitReviewArtifact[],
): ReviewOutcome<true> {
	const knownRefs = knownFindingRefs(unitResults);
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
			if (!knownRefs.has(key)) {
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

	for (const key of knownRefs) {
		if (!seenRefs.has(key)) {
			return fail({
				kind: "invalid_aggregation",
				reason: "omitted_finding",
				message: `Aggregator omitted finding: ${key}`,
				findingRef: key,
			});
		}
	}

	return ok(true);
}

export function maximumSeverity(severities: readonly Severity[]): Severity {
	return severities.reduce<Severity>(
		(current, severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[current] ? severity : current),
		"heuristic",
	);
}

export function minimumConfidence(confidences: readonly Confidence[]): Confidence {
	return confidences.reduce<Confidence>(
		(current, confidence) => (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[current] ? confidence : current),
		"high",
	);
}

function deduplicateEvidence(evidence: readonly VerifiedEvidence[]): VerifiedEvidence[] {
	const unique = new Map<string, VerifiedEvidence>();
	for (const item of evidence) {
		unique.set(`${item.sourceId}:${item.startLine}:${item.endLine}:${item.hash}`, item);
	}
	return [...unique.values()];
}

/** Materialize aggregator groups into findings with preserved evidence and deterministic severity/confidence. */
export function materializeFindingGroups(
	output: AggregationModelOutput,
	unitResults: readonly UnitReviewArtifact[],
): ReviewOutcome<AggregatedFinding[]> {
	const conservation = validateFindingReferenceConservation(output, unitResults);
	if (!conservation.ok) return conservation;

	const findingsByRef = new Map<string, { unitId: string; finding: VerifiedFinding }>();
	for (const artifact of unitResults) {
		if (artifact.status !== "succeeded") continue;
		for (const finding of artifact.review.findings) {
			findingsByRef.set(findingReferenceKey(artifact.unitId, finding.id), {
				unitId: artifact.unitId,
				finding,
			});
		}
	}

	const materialized: AggregatedFinding[] = [];
	for (const [index, group] of output.orderedGroups.entries()) {
		const referenced: Array<{ key: string; unitId: string; finding: VerifiedFinding }> = [];
		for (const reference of group.findingRefs) {
			const key = findingReferenceKey(reference.unitId, reference.findingId);
			const found = findingsByRef.get(key);
			if (!found) {
				return fail({
					kind: "invalid_aggregation",
					reason: "unknown_finding",
					message: `Missing validated finding: ${key}`,
					findingRef: key,
				});
			}
			referenced.push({ key, ...found });
		}

		materialized.push({
			id: `finding-${index + 1}`,
			sourceFindings: referenced.map(item => item.key),
			unitIds: [...new Set(referenced.map(item => item.unitId))],
			title: group.title,
			categories: [...new Set(referenced.map(item => item.finding.category))],
			severity: maximumSeverity(referenced.map(item => item.finding.severity)),
			confidence: minimumConfidence(referenced.map(item => item.finding.confidence)),
			evidence: deduplicateEvidence(referenced.flatMap(item => item.finding.evidence)),
			reason: group.reason,
			suggestedAction: group.recommendedAction,
			verificationAfterChange: group.verificationAfterChange,
		});
	}

	return ok(materialized);
}

/** Coverage gaps from aggregator output, unavailable coverage, and failed units. */
export function deriveCoverageGaps(
	output: AggregationModelOutput,
	unitResults: readonly UnitReviewArtifact[],
	plan: ValidatedPlan,
): ReviewOutcome<Array<{ unitId: string; path: string; reason: string }>> {
	const units = planUnitById(plan);
	const gaps: Array<{ unitId: string; path: string; reason: string }> = [];

	for (const gap of output.coverageGaps) {
		const unit = units.get(gap.unitId);
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
		gaps.push({ unitId: gap.unitId, path: gap.path, reason: gap.reason });
	}

	for (const artifact of unitResults) {
		if (artifact.status === "failed") {
			const unit = units.get(artifact.unitId);
			if (!unit) continue;
			for (const path of unit.primaryFiles) {
				gaps.push({
					unitId: artifact.unitId,
					path,
					reason: artifact.failure.message,
				});
			}
			continue;
		}

		for (const item of artifact.review.coverage) {
			if (item.status === "unavailable") {
				gaps.push({
					unitId: artifact.unitId,
					path: item.path,
					reason: item.notes,
				});
			}
		}
	}

	const unique = new Map<string, { unitId: string; path: string; reason: string }>();
	for (const gap of gaps) unique.set(`${gap.unitId}:${gap.path}`, gap);
	return ok([...unique.values()]);
}

/**
 * Derive run state from plan, unit artifacts, and report presence.
 * completed only when reportPresence is true; otherwise:
 * 0 artifacts → planned, partial → reviewing, all terminal → ready_to_aggregate.
 */
export function deriveReviewRunState(
	plan: ValidatedPlan,
	unitResults: readonly UnitReviewArtifact[],
	reportPresence: boolean,
): ReviewRunState {
	const expectedIds = plan.units.map(unit => unit.id);
	const completedUnitIds: string[] = [];
	const seen = new Set<string>();

	for (const artifact of unitResults) {
		if (!expectedIds.includes(artifact.unitId)) continue;
		if (seen.has(artifact.unitId)) continue;
		if (artifact.status === "succeeded" || artifact.status === "failed") {
			seen.add(artifact.unitId);
			completedUnitIds.push(artifact.unitId);
		}
	}

	const pendingUnitIds = expectedIds.filter(unitId => !seen.has(unitId));

	if (reportPresence) {
		return { state: "completed" };
	}

	if (completedUnitIds.length === 0) {
		return { state: "planned" };
	}

	if (pendingUnitIds.length > 0) {
		return {
			state: "reviewing",
			completedUnitIds,
			pendingUnitIds,
		};
	}

	return { state: "ready_to_aggregate" };
}

/** Convenience: run coverage + verdict consistency checks for a reviewer output. */
export function decideReviewerOutputPolicy(input: {
	unit: ReviewUnit;
	output: ReviewerOutput;
	readPaths: ReadonlySet<string>;
}): ReviewOutcome<{
	coverage: CoverageItem[];
	hasUnavailable: boolean;
	verdict: Verdict;
}> {
	if (input.output.unitId !== input.unit.id) {
		return fail({
			kind: "invalid_unit_result",
			reason: "unknown_unit",
			unitId: input.output.unitId,
			message: `Reviewer returned unit ${input.output.unitId} for ${input.unit.id}`,
		});
	}

	const coverageDecision = decideReviewerCoverage({
		unit: input.unit,
		coverage: input.output.coverage,
		readPaths: input.readPaths,
	});
	if (!coverageDecision.ok) return coverageDecision;

	const verdictDecision = decideReviewerVerdictConsistency({
		unitId: input.unit.id,
		claimedVerdict: input.output.verdict,
		findings: input.output.findings,
		hasUnavailableCoverage: coverageDecision.value.hasUnavailable,
	});
	if (!verdictDecision.ok) return verdictDecision;

	return ok({
		coverage: coverageDecision.value.coverage,
		hasUnavailable: coverageDecision.value.hasUnavailable,
		verdict: verdictDecision.value,
	});
}

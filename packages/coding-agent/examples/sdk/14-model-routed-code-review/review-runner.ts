import { resolve } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import Handlebars from "handlebars";
import type { z } from "zod";
import {
	aggregationOutputSchema,
	CONTEXT_TOOL_POLICY_VERSION,
	type HashFn,
	type PlanArtifact,
	PROMPT_VERSION,
	type PromptExecutionMetadata,
	type PromptResult,
	type PromptRunner,
	parseAggregationOutput,
	parsePlanArtifact,
	parsePlannerOutput,
	parseReviewerOutput,
	plannerOutputSchema,
	REPORT_SCHEMA_VERSION,
	type ReviewFailure,
	type ReviewOutcome,
	type ReviewReport,
	type ReviewUnit,
	type RiskLevel,
	reviewerOutputSchema,
	type Severity,
	type TokenUsage,
	toPlanArtifact,
	UNIT_REVIEW_SCHEMA_VERSION,
	type UnitReviewArtifact,
	type ValidatedPlan,
	type ValidatedReviewUnit,
} from "./contracts";
import aggregatorPrompt from "./prompts/aggregator.md" with { type: "text" };
import aggregatorRequestPrompt from "./prompts/aggregator-request.md" with { type: "text" };
import plannerPrompt from "./prompts/planner.md" with { type: "text" };
import plannerRequestPrompt from "./prompts/planner-request.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };
import reviewerRequestPrompt from "./prompts/reviewer-request.md" with { type: "text" };
import {
	decideAggregationReadiness,
	decideOverallVerdict,
	decideReviewerOutputPolicy,
	deriveCoverageGaps,
	materializeFindingGroups,
	type SourceSnapshot,
	validateUnitSelection,
	verifyEvidence,
} from "./review-policy";

/**
 * Public lifecycle API for model-routed code review.
 * Shell/CLI adapters should depend only on these exports (+ contracts types).
 *
 * Lifecycle: createReviewPlan -> reviewUnit/reviewUnits -> aggregateReview
 * Orchestrator: runReview (full path; always reviews all plan units)
 */
/** Injected wall-clock capability; returns ISO-8601 timestamps. */
export type Clock = {
	now(): string;
};

/** Canonical path/content pair produced by SourceLoader.snapshot. */
export type CanonicalSource = {
	path: string;
	content: string;
};

/**
 * Capability that snapshots canonical file contents for fingerprinting and
 * evidence verification. Must not be implemented with process globals here.
 */
export type SourceLoader = {
	snapshot(paths: readonly string[]): Promise<readonly CanonicalSource[]>;
};

export type CreateReviewPlanRequest = {
	reviewGoal: string;
	riskLevel: RiskLevel;
	targetFiles: readonly string[];
	cwd: string;
	roots: readonly string[];
};

export type CreateReviewPlanDeps = {
	runPrompt: PromptRunner;
	sourceLoader: SourceLoader;
	clock: Clock;
	hash: HashFn;
	thinkingLevel?: ThinkingLevel;
};

export type ReviewUnitRequest = {
	plan: ValidatedPlan;
	unitId: string;
	cwd: string;
	roots: readonly string[];
};

export type ReviewUnitDeps = {
	runPrompt: PromptRunner;
	sourceLoader: SourceLoader;
	hash: HashFn;
	thinkingLevel?: ThinkingLevel;
};

export type ReviewUnitsRequest = {
	plan: ValidatedPlan;
	unitIds: readonly string[];
	cwd: string;
	roots: readonly string[];
};

export type ReviewUnitsDeps = ReviewUnitDeps & {
	concurrency: number;
};

export type AggregateReviewRequest = {
	plan: ValidatedPlan;
	unitReviews: readonly UnitReviewArtifact[];
	cwd: string;
	startedAt: string;
};

export type AggregateReviewDeps = {
	runPrompt: PromptRunner;
	clock: Clock;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

export type RunReviewRequest = {
	reviewGoal: string;
	riskLevel?: RiskLevel;
	targetFiles: readonly string[];
	cwd: string;
	roots: readonly string[];
};

export type RunReviewDeps = {
	runPrompt: PromptRunner;
	sourceLoader: SourceLoader;
	clock: Clock;
	hash: HashFn;
	concurrency: number;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

const SEVERITIES = ["heuristic", "minor", "major", "critical"] as const satisfies readonly Severity[];

const renderPlannerRequest = Handlebars.compile<{ requestJson: string }>(plannerRequestPrompt, { noEscape: true });
const renderReviewerRequest = Handlebars.compile<{ requestJson: string }>(reviewerRequestPrompt, { noEscape: true });
const renderAggregatorRequest = Handlebars.compile<{ requestJson: string }>(aggregatorRequestPrompt, {
	noEscape: true,
});

const plannerPromptSchema = plannerOutputSchema();
const reviewerPromptSchema = reviewerOutputSchema();
const aggregationPromptSchema = aggregationOutputSchema();

type PlannerPromptResult = PromptResult<z.infer<typeof plannerPromptSchema>>;
type ReviewerPromptResult = PromptResult<z.infer<typeof reviewerPromptSchema>>;
type AggregationPromptResult = PromptResult<z.infer<typeof aggregationPromptSchema>>;

function ok<T>(value: T): ReviewOutcome<T> {
	return { ok: true, value };
}

function fail<T>(failure: ReviewFailure): ReviewOutcome<T> {
	return { ok: false, failure };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeAbsolutePaths(cwd: string, paths: readonly string[]): string[] {
	return [...new Set(paths.map(pathValue => resolve(cwd, pathValue)))].sort((left, right) =>
		left.localeCompare(right),
	);
}

function unitToModelDto(unit: ReviewUnit) {
	return {
		id: unit.id,
		title: unit.title,
		objective: unit.objective,
		primary_files: unit.primaryFiles,
		related_files: unit.relatedFiles,
		review_focus: unit.reviewFocus,
		risk_level: unit.riskLevel,
		rationale: unit.rationale,
	};
}

function failedUnitArtifact(input: {
	planFingerprint: string;
	unitId: string;
	unitFingerprint: string;
	failure: ReviewFailure;
	execution?: PromptExecutionMetadata;
}): UnitReviewArtifact {
	return {
		schemaVersion: UNIT_REVIEW_SCHEMA_VERSION,
		planFingerprint: input.planFingerprint,
		unitId: input.unitId,
		unitFingerprint: input.unitFingerprint,
		status: "failed",
		failure: input.failure,
		...(input.execution ? { execution: input.execution } : {}),
	};
}

async function computeSourceFingerprint(input: {
	cwd: string;
	targetFiles: readonly string[];
	sourceLoader: SourceLoader;
	hash: HashFn;
}): Promise<ReviewOutcome<string>> {
	const orderedPaths = normalizeAbsolutePaths(input.cwd, input.targetFiles);
	let snapshots: readonly CanonicalSource[];
	try {
		snapshots = await input.sourceLoader.snapshot(orderedPaths);
	} catch (error) {
		return fail({
			kind: "invalid_plan",
			reason: "path",
			message: `Failed to snapshot review targets: ${errorMessage(error)}`,
		});
	}

	const byPath = new Map<string, string>();
	for (const snapshot of snapshots) {
		byPath.set(resolve(input.cwd, snapshot.path), snapshot.content);
	}

	for (const pathValue of orderedPaths) {
		if (!byPath.has(pathValue)) {
			return fail({
				kind: "invalid_plan",
				reason: "path",
				message: `Missing canonical snapshot for target: ${pathValue}`,
				target: pathValue,
			});
		}
	}

	const canonical = JSON.stringify(
		orderedPaths.map(pathValue => ({ path: pathValue, content: byPath.get(pathValue)! })),
	);
	return ok(input.hash(canonical));
}

async function loadSourceSnapshots(input: {
	cwd: string;
	unitId: string;
	paths: readonly string[];
	readPaths: ReadonlySet<string>;
	sourceLoader: SourceLoader;
}): Promise<ReviewOutcome<SourceSnapshot[]>> {
	const orderedPaths = normalizeAbsolutePaths(input.cwd, input.paths);
	if (orderedPaths.length === 0) return ok([]);

	let snapshots: readonly CanonicalSource[];
	try {
		snapshots = await input.sourceLoader.snapshot(orderedPaths);
	} catch (error) {
		return fail({
			kind: "invalid_evidence",
			unitId: input.unitId,
			message: `Failed to snapshot evidence sources: ${errorMessage(error)}`,
		});
	}

	const byPath = new Map<string, string>();
	for (const snapshot of snapshots) {
		byPath.set(resolve(input.cwd, snapshot.path), snapshot.content);
	}

	const loaded: SourceSnapshot[] = [];
	for (const pathValue of orderedPaths) {
		const content = byPath.get(pathValue);
		if (content === undefined) {
			return fail({
				kind: "invalid_evidence",
				unitId: input.unitId,
				sourceId: pathValue,
				message: `Missing canonical snapshot for evidence source: ${pathValue}`,
			});
		}
		loaded.push({
			sourceId: pathValue,
			content,
			wasRead: input.readPaths.has(pathValue),
		});
	}
	return ok(loaded);
}

function createSemaphore(permits: number) {
	let available = Math.max(1, permits);
	const waiters: Array<() => void> = [];

	return {
		async acquire(): Promise<void> {
			if (available > 0) {
				available -= 1;
				return;
			}
			const { promise, resolve: release } = Promise.withResolvers<void>();
			waiters.push(release);
			await promise;
		},
		release(): void {
			const next = waiters.shift();
			if (next) {
				next();
				return;
			}
			available += 1;
		},
	};
}

function sumTokenUsage(usages: readonly TokenUsage[]): TokenUsage {
	return usages.reduce(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			reasoning: total.reasoning + usage.reasoning,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			totalTokens: total.totalTokens + usage.totalTokens,
		}),
		{ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	);
}

function mergeContextToolUsage(executions: readonly PromptExecutionMetadata[]) {
	const callsByTool: Record<string, number> = {};
	for (const execution of executions) {
		for (const [toolName, calls] of Object.entries(execution.contextTools.callsByTool)) {
			callsByTool[toolName] = (callsByTool[toolName] ?? 0) + calls;
		}
	}
	return {
		requestedCalls: executions.reduce((sum, execution) => sum + execution.contextTools.requestedCalls, 0),
		blockedCalls: executions.reduce((sum, execution) => sum + execution.contextTools.blockedCalls, 0),
		callsByTool,
	};
}

function buildAggregatorRequest(plan: ValidatedPlan, unitResults: readonly UnitReviewArtifact[]) {
	return {
		plan: {
			schemaVersion: plan.schemaVersion,
			promptVersion: plan.promptVersion,
			planFingerprint: plan.planFingerprint,
			reviewGoal: plan.reviewGoal,
			riskLevel: plan.riskLevel,
			targetFiles: plan.targetFiles,
			sourceFingerprint: plan.sourceFingerprint,
			units: plan.units.map((unit: ValidatedReviewUnit) => ({
				id: unit.id,
				title: unit.title,
				objective: unit.objective,
				primaryFiles: unit.primaryFiles,
				relatedFiles: unit.relatedFiles,
				reviewFocus: unit.reviewFocus,
				riskLevel: unit.riskLevel,
				rationale: unit.rationale,
				unitFingerprint: unit.unitFingerprint,
			})),
		},
		unitResults: unitResults.map(artifact => {
			if (artifact.status === "succeeded") {
				return {
					status: artifact.status,
					unitId: artifact.unitId,
					unitFingerprint: artifact.unitFingerprint,
					review: artifact.review,
				};
			}
			return {
				status: artifact.status,
				unitId: artifact.unitId,
				unitFingerprint: artifact.unitFingerprint,
				failure: artifact.failure,
			};
		}),
	};
}

function durationMsSince(startedAt: string, endedAt: string): number {
	const startedMs = Date.parse(startedAt);
	const endedMs = Date.parse(endedAt);
	if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return 0;
	return Math.max(0, Math.round(endedMs - startedMs));
}

/**
 * Snapshot targets, fingerprint sources, call the planner once, and return a
 * PlanArtifact without executing unit review.
 */
export async function createReviewPlan(
	request: CreateReviewPlanRequest,
	deps: CreateReviewPlanDeps,
): Promise<ReviewOutcome<PlanArtifact>> {
	const targetFiles = normalizeAbsolutePaths(request.cwd, request.targetFiles);
	if (targetFiles.length === 0) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: "At least one target file is required",
		});
	}

	const fingerprint = await computeSourceFingerprint({
		cwd: request.cwd,
		targetFiles,
		sourceLoader: deps.sourceLoader,
		hash: deps.hash,
	});
	if (!fingerprint.ok) return fingerprint;

	const roots = normalizeAbsolutePaths(request.cwd, request.roots);
	let promptResult: PlannerPromptResult;
	try {
		promptResult = await deps.runPrompt({
			stage: "planner",
			resultSchema: plannerPromptSchema,
			systemPrompt: plannerPrompt,
			userPrompt: renderPlannerRequest({
				requestJson: JSON.stringify(
					{
						review_goal: request.reviewGoal,
						risk_level: request.riskLevel,
						target_files: targetFiles,
					},
					null,
					2,
				),
			}),
			contextTools: { mode: "planner", roots },
			...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
		});
	} catch (error) {
		return fail({
			kind: "prompt_failed",
			stage: "planner",
			message: errorMessage(error),
		});
	}

	const parsed = parsePlannerOutput(promptResult.output, {
		cwd: request.cwd,
		roots,
		targetFiles,
	});
	if (!parsed.ok) return parsed;

	return ok(
		toPlanArtifact({
			reviewGoal: request.reviewGoal,
			riskLevel: request.riskLevel,
			targetFiles,
			sourceFingerprint: fingerprint.value,
			units: parsed.value.units,
			createdAt: deps.clock.now(),
			plannerExecution: promptResult.execution,
		}),
	);
}

/**
 * Review exactly one validated plan unit and always return a terminal
 * UnitReviewArtifact. Prompt/coverage/evidence failures become failed artifacts.
 */
export async function reviewUnit(request: ReviewUnitRequest, deps: ReviewUnitDeps): Promise<UnitReviewArtifact> {
	const selection = validateUnitSelection(request.plan, [request.unitId]);
	const planUnit = request.plan.units.find(unit => unit.id === request.unitId);

	if (!selection.ok || !planUnit) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: request.unitId,
			unitFingerprint: planUnit?.unitFingerprint ?? "0".repeat(64),
			failure: selection.ok
				? {
						kind: "invalid_unit_result",
						reason: "unknown_unit",
						unitId: request.unitId,
						message: `Unknown unit id selected: ${request.unitId}`,
					}
				: selection.failure,
		});
	}

	const roots = normalizeAbsolutePaths(request.cwd, request.roots);
	let promptResult: ReviewerPromptResult;
	try {
		promptResult = await deps.runPrompt({
			stage: "reviewer",
			resultSchema: reviewerPromptSchema,
			systemPrompt: reviewerPrompt,
			userPrompt: renderReviewerRequest({
				requestJson: JSON.stringify(
					{
						review_goal: request.plan.reviewGoal,
						global_risk_level: request.plan.riskLevel,
						unit: unitToModelDto(planUnit),
					},
					null,
					2,
				),
			}),
			contextTools: { mode: "reviewer", roots },
			...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
		});
	} catch (error) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: planUnit.id,
			unitFingerprint: planUnit.unitFingerprint,
			failure: {
				kind: "prompt_failed",
				stage: "reviewer",
				unitId: planUnit.id,
				message: errorMessage(error),
			},
		});
	}

	const parsed = parseReviewerOutput(promptResult.output, {
		cwd: request.cwd,
		roots,
		unit: planUnit,
	});
	if (!parsed.ok) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: planUnit.id,
			unitFingerprint: planUnit.unitFingerprint,
			failure: parsed.failure,
			execution: promptResult.execution,
		});
	}

	const readPaths = new Set((promptResult.contextReadPaths ?? []).map(pathValue => resolve(request.cwd, pathValue)));
	const policy = decideReviewerOutputPolicy({
		unit: planUnit,
		output: parsed.value,
		readPaths,
	});
	if (!policy.ok) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: planUnit.id,
			unitFingerprint: planUnit.unitFingerprint,
			failure: policy.failure,
			execution: promptResult.execution,
		});
	}

	const evidencePaths = [
		...new Set([
			...planUnit.primaryFiles,
			...planUnit.relatedFiles,
			...parsed.value.findings.flatMap(finding => finding.evidence.map(item => item.sourceId)),
			...readPaths,
		]),
	];
	const snapshots = await loadSourceSnapshots({
		cwd: request.cwd,
		unitId: planUnit.id,
		paths: evidencePaths,
		readPaths,
		sourceLoader: deps.sourceLoader,
	});
	if (!snapshots.ok) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: planUnit.id,
			unitFingerprint: planUnit.unitFingerprint,
			failure: snapshots.failure,
			execution: promptResult.execution,
		});
	}

	const allowedSourceIds = new Set([...planUnit.primaryFiles, ...planUnit.relatedFiles]);
	const verified = verifyEvidence({
		unitId: planUnit.id,
		findings: parsed.value.findings,
		sourceSnapshots: snapshots.value,
		allowedSourceIds,
		hash: deps.hash,
	});
	if (!verified.ok) {
		return failedUnitArtifact({
			planFingerprint: request.plan.planFingerprint,
			unitId: planUnit.id,
			unitFingerprint: planUnit.unitFingerprint,
			failure: verified.failure,
			execution: promptResult.execution,
		});
	}

	return {
		schemaVersion: UNIT_REVIEW_SCHEMA_VERSION,
		planFingerprint: request.plan.planFingerprint,
		unitId: planUnit.id,
		unitFingerprint: planUnit.unitFingerprint,
		status: "succeeded",
		review: {
			unitId: planUnit.id,
			verdict: policy.value.verdict,
			summary: parsed.value.summary,
			findings: verified.value,
			coverage: policy.value.coverage,
		},
		execution: promptResult.execution,
	};
}

/**
 * Validate an explicit unit subset, then review each selected unit independently
 * with bounded concurrency. Preserves request order and does not aggregate.
 */
export async function reviewUnits(
	request: ReviewUnitsRequest,
	deps: ReviewUnitsDeps,
): Promise<ReviewOutcome<UnitReviewArtifact[]>> {
	const selection = validateUnitSelection(request.plan, request.unitIds);
	if (!selection.ok) return selection;

	const selectedUnitIds = selection.value;
	if (selectedUnitIds.length === 0) return ok([]);

	const semaphore = createSemaphore(deps.concurrency);
	const artifacts = await Promise.all(
		selectedUnitIds.map(async unitId => {
			await semaphore.acquire();
			try {
				return await reviewUnit(
					{
						plan: request.plan,
						unitId,
						cwd: request.cwd,
						roots: request.roots,
					},
					{
						runPrompt: deps.runPrompt,
						sourceLoader: deps.sourceLoader,
						hash: deps.hash,
						...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
					},
				);
			} finally {
				semaphore.release();
			}
		}),
	);

	return ok(artifacts);
}

/**
 * Aggregate a complete terminal unit-artifact set into a ReviewReport.
 * Begins the aggregator prompt only after readiness checks succeed.
 */
export async function aggregateReview(
	request: AggregateReviewRequest,
	deps: AggregateReviewDeps,
): Promise<ReviewOutcome<ReviewReport>> {
	const readiness = decideAggregationReadiness(request.plan, request.unitReviews);
	if (!readiness.ok) return readiness;

	const unitResults = readiness.value;
	const knownFindingRefs = unitResults.flatMap(artifact =>
		artifact.status === "succeeded"
			? artifact.review.findings.map(finding => `${artifact.unitId}/${finding.id}`)
			: [],
	);

	let promptResult: AggregationPromptResult;
	try {
		promptResult = await deps.runPrompt({
			stage: "aggregator",
			resultSchema: aggregationPromptSchema,
			systemPrompt: aggregatorPrompt,
			userPrompt: renderAggregatorRequest({
				requestJson: JSON.stringify(buildAggregatorRequest(request.plan, unitResults), null, 2),
			}),
		});
	} catch (error) {
		return fail({
			kind: "prompt_failed",
			stage: "aggregator",
			message: errorMessage(error),
		});
	}

	const parsed = parseAggregationOutput(promptResult.output, {
		plan: request.plan,
		knownFindingRefs,
		cwd: request.cwd,
	});
	if (!parsed.ok) return parsed;

	const findings = materializeFindingGroups(parsed.value, unitResults);
	if (!findings.ok) return findings;

	const coverageGaps = deriveCoverageGaps(parsed.value, unitResults, request.plan);
	if (!coverageGaps.ok) return coverageGaps;

	const failedUnits = unitResults.filter(artifact => artifact.status === "failed");
	const incomplete = failedUnits.length > 0 || coverageGaps.value.length > 0;
	const verdict = decideOverallVerdict({
		findings: findings.value,
		incomplete,
	});

	const reviewerExecutions = unitResults.flatMap(artifact => (artifact.execution ? [artifact.execution] : []));
	const executions = [request.plan.plannerExecution, ...reviewerExecutions, promptResult.execution];
	const endedAt = deps.clock.now();
	const countsBySeverity = Object.fromEntries(
		SEVERITIES.map(severity => [severity, findings.value.filter(finding => finding.severity === severity).length]),
	) as Record<Severity, number>;

	return ok({
		version: REPORT_SCHEMA_VERSION,
		planFingerprint: request.plan.planFingerprint,
		reviewGoal: request.plan.reviewGoal,
		riskLevel: request.plan.riskLevel,
		incomplete,
		units: [...unitResults],
		findings: findings.value,
		coverageGaps: coverageGaps.value,
		aggregate: {
			summary: parsed.value.overallSummary,
			counts: {
				unitCount: request.plan.units.length,
				completedUnitCount: request.plan.units.length - failedUnits.length,
				findingCount: findings.value.length,
				countsBySeverity,
			},
			verdict,
		},
		execution: {
			startedAt: request.startedAt,
			durationMs: durationMsSince(request.startedAt, endedAt),
			modelId: deps.modelId,
			thinkingLevel: String(deps.thinkingLevel),
			promptVersion: PROMPT_VERSION,
			outputSchemaVersion: REPORT_SCHEMA_VERSION,
			contextToolPolicyVersion: CONTEXT_TOOL_POLICY_VERSION,
			tokenUsage: sumTokenUsage(executions.map(execution => execution.tokenUsage)),
			contextTools: mergeContextToolUsage(executions),
			planner: request.plan.plannerExecution,
			reviewers: reviewerExecutions,
			aggregator: promptResult.execution,
		},
	});
}

/**
 * Full lifecycle: plan → validate with current source fingerprint → review all
 * units → aggregate. Reuses the shared stage functions (no duplicated path).
 */
export async function runReview(request: RunReviewRequest, deps: RunReviewDeps): Promise<ReviewOutcome<ReviewReport>> {
	const startedAt = deps.clock.now();
	const riskLevel = request.riskLevel ?? "medium";

	const planArtifact = await createReviewPlan(
		{
			reviewGoal: request.reviewGoal,
			riskLevel,
			targetFiles: request.targetFiles,
			cwd: request.cwd,
			roots: request.roots,
		},
		{
			runPrompt: deps.runPrompt,
			sourceLoader: deps.sourceLoader,
			clock: deps.clock,
			hash: deps.hash,
			thinkingLevel: deps.thinkingLevel,
		},
	);
	if (!planArtifact.ok) return planArtifact;

	const currentFingerprint = await computeSourceFingerprint({
		cwd: request.cwd,
		targetFiles: request.targetFiles,
		sourceLoader: deps.sourceLoader,
		hash: deps.hash,
	});
	if (!currentFingerprint.ok) return currentFingerprint;

	const validatedPlan = parsePlanArtifact(planArtifact.value, {
		cwd: request.cwd,
		roots: [...request.roots],
		targetFiles: [...request.targetFiles],
		sourceFingerprint: currentFingerprint.value,
		hash: deps.hash,
	});
	if (!validatedPlan.ok) return validatedPlan;

	const unitReviews = await reviewUnits(
		{
			plan: validatedPlan.value,
			unitIds: validatedPlan.value.units.map(unit => unit.id),
			cwd: request.cwd,
			roots: request.roots,
		},
		{
			runPrompt: deps.runPrompt,
			sourceLoader: deps.sourceLoader,
			hash: deps.hash,
			concurrency: deps.concurrency,
			thinkingLevel: deps.thinkingLevel,
		},
	);
	if (!unitReviews.ok) return unitReviews;

	return aggregateReview(
		{
			plan: validatedPlan.value,
			unitReviews: unitReviews.value,
			cwd: request.cwd,
			startedAt,
		},
		{
			runPrompt: deps.runPrompt,
			clock: deps.clock,
			modelId: deps.modelId,
			thinkingLevel: deps.thinkingLevel,
		},
	);
}

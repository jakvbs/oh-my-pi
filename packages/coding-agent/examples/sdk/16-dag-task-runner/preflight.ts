import Handlebars from "handlebars";
import { z } from "zod";
import type { DAG } from "./dag";
import preflightReviewPrompt from "./prompts/preflight-review.md" with { type: "text" };
import preflightSystemPrompt from "./prompts/preflight-system.md" with { type: "text" };

/** Duck-typed session surface used by semantic preflight (avoids importing index). */
export interface PreflightRunnerSession {
	readonly isStreaming: boolean;
	abort: () => Promise<void>;
	dispose: () => Promise<void>;
	prompt: (text: string) => Promise<void>;
	subscribe: (listener: (event: PreflightSessionEvent) => void) => () => void;
}

export type PreflightSessionEvent =
	| { type: "terminal_yield"; details: unknown }
	| { type: string; [key: string]: unknown };

export type PreflightSessionFactory = (options: {
	cwd: string;
	model: string;
	purpose: "preflight";
}) => Promise<PreflightRunnerSession>;

export const SEMANTIC_ISSUE_CODES = [
	"MISSING_STEP",
	"GOAL_NOT_COVERED",
	"BAD_DEPENDENCY",
	"CONTEXT_MISMATCH",
	"WRITE_SCOPE_UNCLEAR",
	"NON_ATOMIC_TASK",
	"UNVERIFIABLE_TASK",
	"REDUNDANT_SERIALIZATION",
	"UNSUPPORTED_ASSUMPTION",
] as const;

export const semanticIssueSchema = z.object({
	severity: z.enum(["error", "warning"]),
	code: z.enum(SEMANTIC_ISSUE_CODES),
	task_id: z.string().nullable(),
	reason: z.string().min(1),
	suggested_fix: z.string().min(1),
});

export const semanticReviewSchema = z.object({
	verdict: z.enum(["pass", "revise"]),
	issues: z.array(semanticIssueSchema),
});

export type SemanticIssue = z.infer<typeof semanticIssueSchema>;
export type SemanticReview = z.infer<typeof semanticReviewSchema>;

export class SemanticPreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SemanticPreflightError";
	}
}

const yieldResultEnvelopeSchema = z
	.object({
		status: z.string(),
		error: z.unknown().optional(),
		schemaOverridden: z.unknown().optional(),
		data: z.unknown(),
	})
	.passthrough();

const incrementalYieldSchema = z.object({ type: z.array(z.unknown()).min(1) }).passthrough();

const renderReviewPrompt = Handlebars.compile<{
	dagHash: string;
	goal: string;
	successCriteriaLines: string[];
	normalizedDagJson: string;
}>(preflightReviewPrompt, { noEscape: true });

const CLEANUP_TIMEOUT_MS = 1000;

export function preflightSystemPromptText(): string {
	return preflightSystemPrompt;
}

export function normalizedDagJson(dag: DAG): string {
	return JSON.stringify(dag);
}

export async function hashNormalizedDAG(dag: DAG): Promise<string> {
	const bytes = new TextEncoder().encode(normalizedDagJson(dag));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function renderSemanticReviewPrompt(dag: DAG, dagHash: string): string {
	return renderReviewPrompt({
		dagHash,
		goal: dag.goal,
		successCriteriaLines: dag.success_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
		normalizedDagJson: normalizedDagJson(dag),
	});
}

export function validateSemanticReview(raw: unknown, taskIds: ReadonlySet<string>): SemanticReview {
	const parsed = semanticReviewSchema.parse(raw);
	const hasError = parsed.issues.some(issue => issue.severity === "error");
	if (hasError && parsed.verdict !== "revise") {
		throw new SemanticPreflightError('Semantic review verdict must be "revise" when error issues are present.');
	}
	if (!hasError && parsed.verdict !== "pass") {
		throw new SemanticPreflightError('Semantic review verdict must be "pass" when no error issues are present.');
	}
	for (const issue of parsed.issues) {
		if (issue.task_id !== null && !taskIds.has(issue.task_id)) {
			throw new SemanticPreflightError(`Semantic review references unknown task_id: ${issue.task_id}`);
		}
	}
	return parsed;
}

export function validateTerminalYieldResult(
	details: unknown,
	counts: {
		incrementalYieldCount: number;
		terminalYieldCount: number;
	},
): unknown {
	if (counts.incrementalYieldCount !== 0) {
		throw new SemanticPreflightError(`Semantic review produced ${counts.incrementalYieldCount} non-terminal yields`);
	}
	if (counts.terminalYieldCount !== 1) {
		throw new SemanticPreflightError(`Semantic review produced ${counts.terminalYieldCount} terminal yields`);
	}
	const envelope = yieldResultEnvelopeSchema.parse(details);
	if (envelope.status !== "success") {
		throw new SemanticPreflightError(`Semantic review aborted: ${String(envelope.error ?? "unknown error")}`);
	}
	if ((envelope.schemaOverridden ?? false) !== false) {
		throw new SemanticPreflightError("Semantic review exhausted yield schema retries");
	}
	const [output] = z.array(z.unknown()).length(1).parse(envelope.data);
	return output;
}

export function isIncrementalYield(details: unknown): boolean {
	return incrementalYieldSchema.safeParse(details).success;
}

export function formatSemanticIssues(issues: readonly SemanticIssue[]): string {
	return issues
		.map(issue => {
			const scope = issue.task_id ?? "global";
			return `${issue.severity} · ${issue.code} · ${scope} · ${issue.reason} · ${issue.suggested_fix}`;
		})
		.join("\n");
}

export interface SemanticPreflightOptions {
	cwd: string;
	dag: DAG;
	dagHash: string;
	reviewModel: string;
	reviewTimeoutMs: number;
	sessionFactory: PreflightSessionFactory;
}

export interface SemanticPreflightResult {
	dagHash: string;
	review: SemanticReview;
}

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
	if (timeoutMs <= 0) throw new TimeoutError(timeoutMessage);
	const deferred = Promise.withResolvers<T>();
	let timer: NodeJS.Timeout | undefined = setTimeout(
		() => deferred.reject(new TimeoutError(timeoutMessage)),
		timeoutMs,
	);
	try {
		return await Promise.race([promise, deferred.promise]);
	} finally {
		clearTimeout(timer);
		timer = undefined;
	}
}

async function boundedSessionOperation(
	operation: () => Promise<void>,
	operationName: "abort" | "dispose",
): Promise<void> {
	try {
		await withTimeout(
			operation(),
			CLEANUP_TIMEOUT_MS,
			`Semantic review ${operationName} exceeded ${CLEANUP_TIMEOUT_MS}ms`,
		);
	} catch {
		// Best-effort cleanup; the preflight error already owns the exit path.
	}
}

async function cleanupSession(session: PreflightRunnerSession, forceAbort: boolean): Promise<void> {
	if (forceAbort || session.isStreaming) {
		await boundedSessionOperation(() => session.abort(), "abort");
	}
	await boundedSessionOperation(() => session.dispose(), "dispose");
}

export async function runSemanticPreflight(options: SemanticPreflightOptions): Promise<SemanticPreflightResult> {
	const prompt = renderSemanticReviewPrompt(options.dag, options.dagHash);
	const taskIds = new Set(options.dag.tasks.map(task => task.id));
	let session: PreflightRunnerSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let cleanedUp = false;
	let terminalYieldDetails: unknown;
	let terminalYieldCount = 0;
	let incrementalYieldCount = 0;
	const sessionPromise = options.sessionFactory({
		cwd: options.cwd,
		model: options.reviewModel,
		purpose: "preflight",
	});

	const cleanup = async (target: PreflightRunnerSession | undefined, forceAbort: boolean): Promise<void> => {
		if (!target || cleanedUp) return;
		cleanedUp = true;
		await cleanupSession(target, forceAbort);
	};

	try {
		session = await withTimeout(
			sessionPromise,
			options.reviewTimeoutMs,
			`Semantic review exceeded timeout of ${options.reviewTimeoutMs}ms`,
		);
		unsubscribe = session.subscribe((event: PreflightSessionEvent) => {
			if (event.type !== "terminal_yield") return;
			if (isIncrementalYield(event.details)) {
				incrementalYieldCount++;
				return;
			}
			terminalYieldCount++;
			terminalYieldDetails = event.details;
		});
		await withTimeout(
			session.prompt(prompt),
			options.reviewTimeoutMs,
			`Semantic review exceeded timeout of ${options.reviewTimeoutMs}ms`,
		);
		const raw = validateTerminalYieldResult(terminalYieldDetails, {
			incrementalYieldCount,
			terminalYieldCount,
		});
		const review = validateSemanticReview(raw, taskIds);
		return { dagHash: options.dagHash, review };
	} catch (error) {
		if (error instanceof TimeoutError) {
			await cleanup(session, true);
			if (!session) {
				void sessionPromise.then(late => cleanup(late, true)).catch(() => undefined);
			}
		}
		if (error instanceof SemanticPreflightError || error instanceof TimeoutError) throw error;
		if (error instanceof z.ZodError) {
			throw new SemanticPreflightError(`Semantic review schema mismatch: ${error.message}`);
		}
		throw new SemanticPreflightError(error instanceof Error ? error.message : String(error));
	} finally {
		unsubscribe?.();
		await cleanup(session, false);
	}
}

export { preflightSystemPrompt };

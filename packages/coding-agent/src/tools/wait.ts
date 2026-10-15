import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { buildJobResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { type OutputActivity, type OutputAlert, OutputAlertWatch } from "../async/output-alert";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;
const OUTPUT_STALL_MS = 5 * 60_000;
const OUTPUT_CHECK_INTERVAL_MS = 1_000;

/** Why a blocked wait returned; every result names its wake. */
type WaitWake =
	| { kind: "settled" }
	| { kind: "service" }
	| { kind: "output"; alert: OutputAlert }
	| { kind: "limit" }
	| { kind: "abort" };

export interface WaitToolOptions {
	/** Silence in a running bash job's output that wakes the wait. */
	stallMs?: number;
	/** How often running bash output is scanned for error lines and stalls. */
	outputCheckIntervalMs?: number;
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started. Work it
 * did not start never sustains a wait.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started";
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	readonly #outputWatch: OutputAlertWatch;
	readonly #outputCheckIntervalMs: number;
	readonly description: string;

	constructor(
		private readonly session: ToolSession,
		options: WaitToolOptions = {},
	) {
		this.#outputWatch = new OutputAlertWatch(options.stallMs ?? OUTPUT_STALL_MS);
		this.#outputCheckIntervalMs = options.outputCheckIntervalMs ?? OUTPUT_CHECK_INTERVAL_MS;
		this.description = prompt.render(waitDescription, {
			stallMinutes: this.#outputWatch.stallMs / 60_000,
			limitMinutes: WAIT_MAX_MS / 60_000,
		});
	}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const senderId = this.session.getAgentId?.() ?? undefined;
		const manager = this.session.asyncJobManager;

		// Refreshes owned-service tracking only; jobs are in-process, so a hung
		// broker must not turn every wait into an error.
		if (cfgLaunchEnabled.get(this.session.settings)) {
			await listServicesTolerant(this.session, signal);
		}
		const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
		// An accepted completion whose delivery has not reached the transcript
		// yet (queued, parked on the yield queue, or skipped while an earlier
		// wait watched it) is exactly what this wait is for: return it now.
		const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
		if (manager && undelivered.length > 0) {
			return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
		}
		const serviceRunning = hasLiveOwnedService(this.session);
		if (jobs.length === 0 && !serviceRunning) {
			throw new ToolError("Nothing to wait for: no background job or service you started is running.");
		}
		return this.#blockUntilWake({ jobs, manager, serviceRunning, signal, onUpdate });
	}

	/**
	 * Block until an owned job settles, a running bash job prints an error line
	 * or falls silent, an owned service finishes, the cap elapses, or the call
	 * aborts.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		serviceRunning: boolean;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails>> {
		const { jobs, manager, serviceRunning, signal, onUpdate } = args;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, WAIT_MAX_MS);
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		this.#outputWatch.forget(new Set(jobs.map(job => job.id)));
		const outputAlert = Promise.withResolvers<OutputAlert>();
		const checkOutput = () => {
			const alert = this.#outputWatch.check(jobs, Date.now());
			if (alert) outputAlert.resolve(alert);
		};
		checkOutput();
		const outputTimer = setInterval(checkOutput, this.#outputCheckIntervalMs);
		let wake: WaitWake;
		try {
			wake = await Promise.race<WaitWake>([
				...jobs.map(job => job.promise.then(() => ({ kind: "settled" as const }))),
				outputAlert.promise.then(alert => ({ kind: "output" as const, alert })),
				...(serviceLeg ? [serviceLeg.then(() => ({ kind: "service" as const }))] : []),
				timeout.then(() => ({ kind: "limit" as const })),
				abort.promise.then(() => ({ kind: "abort" as const })),
			]);
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			clearInterval(outputTimer);
			serviceAbort.abort();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (an interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			if (signal?.aborted) {
				// Steering or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
						useless: true,
					};
				}
				throwIfAborted(signal);
			}
			const snapshot =
				manager && jobs.length > 0 ? await buildJobResult(this.session, manager, "wait", jobs, []) : undefined;
			if (snapshot && wake.kind === "output") return withOutputAlert(snapshot, wake.alert);
			if (wake.kind === "limit") {
				const now = Date.now();
				const status = jobs
					.filter(job => job.status === "running")
					.map(job => describeRunningJob(job, this.#outputWatch.activity(job.id), now));
				return withWaitLimit(snapshot, status);
			}
			if (snapshot) return snapshot;
			return {
				content: [{ type: "text", text: "A service finished. Read proc:// for its status and output." }],
				details: { op: "wait", jobs: [] },
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

function describeRunningJob(job: AsyncJob, activity: OutputActivity | undefined, now: number): string {
	const ran = `\`${job.id}\` has run ${minutes(now - job.startTime)}`;
	if (job.type !== "bash" || !activity) return `${ran}.`;
	if (!activity.printed) return `${ran} and printed nothing.`;
	const quietMs = now - activity.changedAt;
	return quietMs < 60_000
		? `${ran}; its output changed within the last minute.`
		: `${ran}; its output last changed ${minutes(quietMs)} ago.`;
}

/**
 * Leads the snapshot with the limit that ended the wait, so the result never
 * reads like a wait that returned at once.
 */
function withWaitLimit(
	snapshot: AgentToolResult<CoordinationDetails> | undefined,
	status: readonly string[],
): AgentToolResult<CoordinationDetails> {
	const text = [
		"## Wait limit reached\n",
		`This wait blocked for its ${minutes(WAIT_MAX_MS)} limit. Nothing finished, printed an error line, or stalled.`,
		...status,
		"Call `wait` again to keep waiting, or cancel a job you no longer need.",
		...(snapshot ? ["", ...snapshot.content.flatMap(part => (part.type === "text" ? [part.text] : []))] : []),
	].join("\n");
	return { ...(snapshot ?? { details: { op: "wait", jobs: [] } }), content: [{ type: "text", text }] };
}

/**
 * Leads the jobs snapshot with the output that woke the wait. The job still
 * runs, so the result is new information even though every job is running.
 */
function withOutputAlert(
	result: AgentToolResult<CoordinationDetails>,
	alert: OutputAlert,
): AgentToolResult<CoordinationDetails> {
	const reason =
		alert.kind === "error"
			? `\`${alert.jobId}\` printed an error line and is still running.`
			: `\`${alert.jobId}\` printed nothing for ${minutes(alert.silentMs)} after steady output and is still running.`;
	const text = [
		"## Output alert\n",
		reason,
		"```",
		alert.fragment || "(no output)",
		"```",
		"Call `wait` again to keep waiting, or cancel the job if this output makes the rest of the run moot.",
		"",
		...result.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
	].join("\n");
	const { useless: _useless, ...rest } = result;
	return { ...rest, content: [{ type: "text", text }] };
}

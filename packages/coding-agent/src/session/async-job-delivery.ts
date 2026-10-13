/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";

/**
 * `customType` of the injected async-result follow-up message. `runSessionToYield`
 * matches on it to invalidate a previously recorded yield: a result injected
 * after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
/**
 * Tail share of the preview when the link points at a raw capture: tools append
 * notices (wall time, exit code, timeout) after the captured stream.
 */
export const ASYNC_PREVIEW_TAIL_CHARS = 1_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	status?: AsyncJob["status"];
	label?: string;
	durationMs?: number;
	/** Source capture metadata belongs to this job, not to the enclosing delivery report. */
	meta?: OutputMeta;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	meta?: OutputMeta;
};

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		// Job output is text the job controls: it must not close the
		// `<system-notice>` it renders into or open a forged harness block.
		return {
			jobId: entry.jobId,
			result: escapeHarnessTags(entry.result),
			type: entry.job?.type,
			status: entry.job?.status,
			label: entry.job?.label,
			durationMs: entry.durationMs,
			meta: entry.job?.latestDetails?.meta,
		};
	});
	const details: AsyncResultDetails = {
		meta: { source: { type: "report", value: "background job delivery" } },
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			status: job.status,
			label: job.label,
			durationMs: job.durationMs,
			...(job.meta ? { meta: job.meta } : {}),
		})),
	};
	const text = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	const images = entries.flatMap(entry => entry.job?.latestDetails?.images ?? []);
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

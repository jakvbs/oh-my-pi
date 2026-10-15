/**
 * Lifecycle control for async background jobs (bash scripts, eval cells)
 * owned by the calling agent: wait/cancel/snapshot.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

import type { AsyncJob, AsyncJobDetails, AsyncJobManager, AsyncJobType } from "./job-manager";

import type { ToolSession } from "../tools";

import type { CancelOutcome, CoordinationDetails, JobSnapshot } from "@oh-my-pi/pi-tui/tools/wait";

import { isWaitingPollDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { formatArtifactErrorNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { formatBackgroundResult } from "../session/async-job-delivery";

/**
 * Resolve a list of job ids to job records visible to the calling agent.
 * Drops missing ids and ids owned by other agents, preventing cross-agent inspection.
 * An unowned caller (`ownerId` undefined) sees only unowned jobs.
 */
export function visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
	const out: AsyncJob[] = [];
	for (const id of ids) {
		const job = manager.getJob(id);
		if (!job) continue;
		if (job.ownerId !== ownerId) continue;
		out.push(job);
	}
	return out;
}

/**
 * Settled jobs owned by `ownerId` whose completion was accepted but has not
 * reached the owner yet: delivery queued or awaiting yield-queue injection,
 * dead-lettered, or skipped while a `wait` watched it. Consumed, acknowledged,
 * and currently watched results are excluded.
 */
export function undeliveredJobs(manager: AsyncJobManager, ownerId: string | undefined): AsyncJob[] {
	return manager
		.getAllJobs({ ownerId })
		.filter(
			job =>
				(job.status === "completed" || job.status === "failed") &&
				!manager.isJobResultConsumed(job.id) &&
				!manager.isDeliverySuppressed(job.id),
		);
}

interface TrackedJobLike {
	id: string;
	type: AsyncJobType;
	status: string;
	label: string;
	startTime: number;
	endTime?: number;
	latestDetails?: AsyncJobDetails;
	resultText?: string;
	errorText?: string;
}

export function snapshotJobs(
	session: ToolSession,
	jobs: TrackedJobLike[],
	options: { includeResults?: boolean } = {},
): JobSnapshot[] {
	const now = Date.now();
	return jobs.map(j => {
		const current = session.asyncJobManager?.getJob(j.id);
		const latest = current ?? j;
		const resultConsumed = session.asyncJobManager?.isJobResultConsumed(latest.id) === true;
		const exitCode = typeof latest.latestDetails?.exitCode === "number" ? latest.latestDetails.exitCode : undefined;
		return {
			id: latest.id,
			type: latest.type,
			status: latest.status as JobSnapshot["status"],
			label: latest.label,
			durationMs: Math.max(0, (latest.endTime ?? now) - latest.startTime),
			...(exitCode !== undefined ? { exitCode } : {}),
			...(!resultConsumed && options.includeResults !== false && latest.resultText
				? { resultText: latest.resultText }
				: {}),
			...(!resultConsumed && options.includeResults !== false && latest.errorText
				? { errorText: latest.errorText }
				: {}),
			...((options.includeResults === false || !resultConsumed) && latest.latestDetails?.meta
				? { meta: latest.latestDetails.meta }
				: {}),
		};
	});
}

export async function buildJobResult(
	session: ToolSession,
	manager: AsyncJobManager,
	op: "wait" | "cancel" | "jobs",
	jobs: TrackedJobLike[],
	cancelOutcomes: CancelOutcome[],
): Promise<AgentToolResult<CoordinationDetails>> {
	// Deduplicate by id (cancelled jobs may also appear in the watched set).
	const seen = new Set<string>();
	const uniqueJobs = jobs.filter(j => {
		if (seen.has(j.id)) return false;
		seen.add(j.id);
		return true;
	});
	const jobResults = snapshotJobs(session, uniqueJobs, { includeResults: op !== "jobs" });
	const alreadyConsumed = new Set(jobResults.filter(job => manager.isJobResultConsumed(job.id)).map(job => job.id));

	if (op !== "jobs") {
		manager.consumeJobResults(jobResults.filter(j => j.status !== "running").map(j => j.id));
	}

	const completed = jobResults.filter(j => j.status !== "running");
	const running = jobResults.filter(j => j.status === "running");

	const lines: string[] = [];

	if (cancelOutcomes.length > 0) {
		lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
		for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
		lines.push("");
	}

	if (op === "jobs" && jobResults.length > 0) {
		lines.push(`## Jobs (${jobResults.length})\n`);
		for (const j of jobResults) {
			const exit = j.exitCode === undefined ? "" : ` — exit ${j.exitCode}`;
			const artifactId = j.meta?.truncation?.artifactId;
			const artifact = artifactId ? ` — artifact://${artifactId}` : "";
			const capture =
				j.meta?.artifactError === undefined ? "" : ` — ${formatArtifactErrorNotice(j.meta.artifactError)}`;
			const delivery =
				j.status === "running" || j.status === "cancelled"
					? ""
					: ` — delivery ${alreadyConsumed.has(j.id) ? "delivered" : "pending"}`;
			lines.push(
				`- \`${j.id}\` [${j.type}] — ${j.status} — ${j.label.replace(/\s+/g, " ")}${exit}${artifact}${capture}${delivery}`,
			);
		}
	} else if (completed.length > 0) {
		const allocateOutputArtifact = session.allocateOutputArtifact;
		const allocate = allocateOutputArtifact && (() => allocateOutputArtifact("async"));
		lines.push(`## Completed (${completed.length})\n`);
		for (const j of completed) {
			lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
			lines.push(`Label: ${j.label}`);
			if (j.status !== "cancelled") {
				lines.push(
					alreadyConsumed.has(j.id)
						? "Delivery: already delivered or recovered."
						: "Delivery: not auto-delivered; recovered by this snapshot.",
				);
			}
			if (j.resultText) {
				lines.push("```", await formatBackgroundResult(j.resultText, j.meta, allocate), "```");
			}
			if (j.errorText) {
				lines.push(`Error: ${await formatBackgroundResult(j.errorText, j.meta, allocate)}`);
			}
			lines.push("");
		}
	}

	if (op !== "jobs" && running.length > 0) {
		lines.push(`## Still Running (${running.length})\n`);
		for (const j of running) {
			lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
		}
	}

	// A tool result must never be empty text — the model cannot tell "no
	// jobs" from a malfunction (reported exactly that way in QA).
	if (lines.length === 0) {
		lines.push("No background jobs.");
	}

	const details: CoordinationDetails = {
		op,
		// The report is complete even when an individual job's raw capture failed.
		meta: { source: { type: "report", value: "background jobs snapshot" } },
		jobs: jobResults,
		...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
	};
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() }],
		details,
		// A wait where everything is still running carries no new information
		// once a later wait exists — same predicate the TUI uses to displace
		// stale waiting frames.
		...(isWaitingPollDetails(details) ? { useless: true } : {}),
	};
}

/** `cancel`: kill the named jobs; returns immediately with outcomes + snapshots. */
export async function executeCancel(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
	ids: string[],
): Promise<AgentToolResult<CoordinationDetails>> {
	const cancelOutcomes: CancelOutcome[] = [];
	for (const id of ids) {
		const existing = manager.getJob(id);
		if (!existing || existing.ownerId !== ownerId) {
			cancelOutcomes.push({ id, status: "not_found", message: `Background job not found: ${id}` });
			continue;
		}
		if (existing.status !== "running") {
			cancelOutcomes.push({
				id,
				status: "already_completed",
				message: `Background job ${id} is already ${existing.status}.`,
			});
			continue;
		}
		const cancelled = manager.cancel(id, { ownerId });
		cancelOutcomes.push(
			cancelled
				? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
				: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
		);
	}
	return buildJobResult(session, manager, "cancel", visibleJobs(manager, ids, ownerId), cancelOutcomes);
}

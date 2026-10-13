import type { Component } from "../tui";
import { Text } from "../components/text";
import { visibleWidth } from "../utils";
import { shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { Theme } from "../theme/theme";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../render/index";
import { formatArtifactErrorNotice, stripOutputNotice, type OutputMeta } from "./output-meta";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "../render/render-utils";
import type { RenderResultOptions, ToolRenderer, ToolActivitySummary } from "./renderer";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { compact, elapsed, node, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, ToolRenderResult } from "./renderer";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
/** Coordination details retained by wait and background job operations. */
export type CoordinationOp = "wait" | "jobs" | "cancel";

/** Background-job row surfaced by `wait`/`cancel`/`jobs` results. */
export interface JobSnapshot {
	id: string;
	type: "bash" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	/** Process exit status when the job reports one. */
	exitCode?: number;
	resultText?: string;
	errorText?: string;
	/** Source-output metadata retained for per-job warnings and persisted row rendering. */
	meta?: OutputMeta;
	/** Capture error in historical snapshots; new snapshots store source metadata in `meta`. */
	artifactError?: OutputMeta["artifactError"];
}

/** Outcome of cancelling one background job. */
export type CancelStatus = "cancelled" | "not_found" | "already_completed";

/** Cancellation outcome and its model-facing explanation. */
export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/** Details of job/wait results. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: CoordinationOp;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** `wait` was cut short by steering or a completion notice that injects next. */
	interrupted?: boolean;
}

// =============================================================================
// TUI Renderer
// =============================================================================

const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

/** Pending wait frame. */
function waitRenderCall(_args: object, _options: RenderResultOptions, uiTheme: Theme): Component {
	return new Text(renderStatusLine({ icon: "pending", title: "Wait" }, uiTheme), 0, 0);
}

/** Result frame for wait snapshots. */
function jobsRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const jobs = result.details?.jobs ?? [];

	if (jobs.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: "Wait" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	// Sealing freezes the snapshot; still-running rows remain meaningful history.

	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;

	// The title already carries the running count, so meta lists only the
	// settled categories — "waiting on 19 of 19 · 19 running" read awkward.
	const meta: string[] = [];
	if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));

	const headerIcon: ToolUIStatus = counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success";
	const jobsNoun = jobs.length === 1 ? "job" : "jobs";
	const description =
		counts.running > 0
			? counts.running === jobs.length
				? `waiting on ${jobs.length} ${jobsNoun}`
				: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
			: `${jobs.length} ${jobsNoun} settled`;

	const header = renderStatusLine(
		{
			icon: headerIcon,
			spinnerFrame: counts.running > 0 ? options.spinnerFrame : undefined,
			title: description,
			meta,
		},
		uiTheme,
	);

	const outputMeta = result.details?.meta;
	// Historical snapshots promoted a job failure to the root. Render it there
	// only when no row identifies that failure; new report capture errors are distinct.
	const aggregateArtifactError =
		outputMeta?.artifactError &&
		(outputMeta.source?.type === "report" ||
			!jobs.some(job => (job.meta?.artifactError ?? job.artifactError) === outputMeta.artifactError))
			? outputMeta.artifactError
			: undefined;

	// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
	const statusOrder: Record<JobSnapshot["status"], number> = {
		running: 0,
		failed: 1,
		cancelled: 2,
		completed: 3,
	};
	const sortedJobs = [...jobs].sort((a, b) => {
		const diff = statusOrder[a.status] - statusOrder[b.status];
		if (diff !== 0) return diff;
		return b.durationMs - a.durationMs;
	});

	let cached: RenderCache | undefined;
	// Per-job preview rows are invariant across spinner/shimmer frames (the job
	// snapshots are frozen for this result), so the envelope strip, flatten and
	// wrap run once per (job, expanded, width) instead of every animated frame.
	const previewRows = new Map<JobSnapshot, { expanded: boolean; width: number; lines: readonly string[] }>();
	const jobPreviewRows = (job: JobSnapshot, expanded: boolean, continuationWidth: number): readonly string[] => {
		const hit = previewRows.get(job);
		if (hit !== undefined && hit.expanded === expanded && hit.width === continuationWidth) return hit.lines;
		const artifactError = job.meta?.artifactError ?? job.artifactError;
		// Legacy rows did not retain full metadata. Strip the known warning
		// footer so the dedicated row/root warning remains the only copy.
		const previewError =
			artifactError ?? (outputMeta?.source?.type !== "report" ? outputMeta?.artifactError : undefined);
		const previewMeta = job.meta ?? (previewError ? { artifactError: previewError } : undefined);
		const preview = flattenStructuredPreview(
			stripOutputNotice(job.errorText?.trim() || job.resultText?.trim() || "", previewMeta).trim(),
		);
		const lines: string[] = [];
		if (preview) {
			const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
			const previewLines = getPreviewLines(
				preview,
				maxLines,
				Math.min(PREVIEW_LINE_WIDTH, continuationWidth),
				Ellipsis.Unicode,
			);
			const tone = job.errorText ? "error" : "dim";
			for (const pl of previewLines) lines.push(`  ${uiTheme.fg(tone, pl)}`);
		}
		previewRows.set(job, { expanded, width: continuationWidth, lines });
		return lines;
	};
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded;
			const spinnerFrame = options.spinnerFrame ?? 0;
			// Running-job labels shimmer while the wait block is live; the band
			// phase is Date.now()-sampled at render time, so serving cached bytes
			// would pin it to the ~12.5fps spinner-glyph cadence instead of the
			// 30fps redraw. Bypass the cache while any row animates, and key on
			// the animation state so a sealed block never hits stale shimmered
			// bytes (spinnerFrame falls back to 0 on both sides of the seal).
			const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
			const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const itemLines = renderTreeList<JobSnapshot>(
				{
					items: sortedJobs,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "job",
					renderItem: (job, context) => {
						const rowWidth = Math.max(0, width - (context.prefixWidth ?? 0));
						const lines: string[] = [];
						const icon = `${formatStatusIcon(
							statusToIcon(job.status),
							uiTheme,
							job.status === "running" ? options.spinnerFrame : undefined,
						)}${job.exitCode === undefined ? "" : `${uiTheme.sep.dot}${uiTheme.fg(job.exitCode === 0 ? "muted" : "error", `exit ${job.exitCode}`)}`}`;
						const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
						const durationSuffix = `${uiTheme.sep.dot}${uiTheme.fg("dim", formatDuration(job.durationMs))}`;
						const displayId = truncateToWidth(
							replaceTabs(job.id).replace(/\s+/g, " "),
							Math.max(0, rowWidth - visibleWidth(`${icon} ${typeBadge} ${durationSuffix}`)),
							Ellipsis.Unicode,
						);
						const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
						const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
						const visibleLabelLines = rawLabelLines
							.slice(0, maxLabelLines)
							.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
						if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
							const last = visibleLabelLines[visibleLabelLines.length - 1]!;
							visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
						}
						const rowPrefix = `${icon} ${typeBadge} `;
						const headRaw = displayId;
						// Running rows in a live block shimmer their label; once the block
						// stops animating (sealed, or a settled snapshot — spinnerFrame
						// cleared) they render static so scrollback never keeps a mid-sweep
						// shimmer band.
						const live = job.status === "running" && options.spinnerFrame !== undefined;
						const headLabel = live
							? shimmerEnabled()
								? shimmerText(headRaw, uiTheme)
								: uiTheme.fg("accent", headRaw)
							: uiTheme.fg("toolOutput", headRaw);
						let row = `${rowPrefix}${headLabel}`;
						const distinctLabel = job.label.trim() !== job.id;
						const label = visibleLabelLines[0] ?? "";
						const inlineLabel = distinctLabel && visibleWidth(`${row} ${label}${durationSuffix}`) <= rowWidth;
						if (inlineLabel) row += ` ${uiTheme.fg("toolOutput", label)}`;
						row += durationSuffix;
						lines.push(truncateToWidth(row, rowWidth, ""));
						const continuationWidth = Math.max(0, rowWidth - visibleWidth("  "));
						for (let i = distinctLabel && !inlineLabel ? 0 : 1; i < visibleLabelLines.length; i++) {
							lines.push(
								`  ${uiTheme.fg("toolOutput", truncateToWidth(visibleLabelLines[i]!, continuationWidth))}`,
							);
						}
						const artifactError = job.meta?.artifactError ?? job.artifactError;
						if (artifactError) {
							lines.push(
								uiTheme.fg("warning", truncateToWidth(formatArtifactErrorNotice(artifactError), rowWidth)),
							);
						}

						for (const previewLine of jobPreviewRows(job, expanded, continuationWidth)) lines.push(previewLine);
						return lines;
					},
				},
				uiTheme,
			);

			const all = [header];
			if (aggregateArtifactError) {
				all.push(uiTheme.fg("warning", formatArtifactErrorNotice(aggregateArtifactError)));
			}
			all.push(...itemLines);
			for (let i = 0; i < all.length; i++) all[i] = truncateToWidth(all[i]!, width, Ellipsis.Unicode);
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

/**
 * One job row on one line: type badge, id + label, terminal-clocked duration
 * (live while running). The job's output and errors fill the card of the call
 * that started it (`parksAsBackground`), so the row carries no preview.
 */
function describeJob(job: JobSnapshot, isPartial: boolean): NativeNode {
	const running = job.status === "running" && isPartial;
	const label = job.label.trim() !== job.id ? plainText(job.label.split(/\r?\n/)[0] ?? "") : "";
	const spans: TspSpan[] = [
		span(plainText(job.id), running ? "accent" : "toolOutput", running ? { fx: "shimmer" } : undefined),
	];
	if (label) spans.push(span(` ${label}`, "toolOutput"));
	if (job.exitCode !== undefined) spans.push(span(` exit ${job.exitCode}`, job.exitCode === 0 ? "muted" : "error"));
	const tone =
		job.status === "completed"
			? "success"
			: job.status === "failed"
				? "error"
				: job.status === "cancelled"
					? "warning"
					: "accent";
	return node(
		"row",
		{ role: "omp.wait.job", tone, gap: "sm" },
		compact([
			node("badge", { text: job.type, tone }),
			text(spans, { truncate: "end", grow: 1 }),
			elapsed(job.durationMs, !running),
		]),
		job.id,
	);
}

function describeJobsResult(
	result: ToolRenderResult<CoordinationDetails>,
	isPartial: boolean,
): NativeToolView | undefined {
	const jobs = result.details?.jobs ?? [];
	if (jobs.length === 0) {
		return {
			head: toolHead("Wait"),
			tone: "warning",
			body: [text([span(plainText(resultText(result) || "No jobs to process"), "dim")])],
		};
	}
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;
	const noun = jobs.length === 1 ? "job" : "jobs";
	const title =
		counts.running > 0
			? counts.running === jobs.length
				? `waiting on ${jobs.length} ${noun}`
				: `waiting on ${counts.running} of ${jobs.length} ${noun}`
			: `${jobs.length} ${noun} settled`;
	const head: TspSpan[] = [span(title, "toolTitle strong")];
	if (counts.completed > 0) head.push(span(` ${counts.completed} done`, "success"));
	if (counts.failed > 0) head.push(span(` ${counts.failed} failed`, "error"));
	if (counts.cancelled > 0) head.push(span(` ${counts.cancelled} cancelled`, "warning"));
	const order: Record<JobSnapshot["status"], number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };
	const sorted = [...jobs].sort((a, b) => order[a.status] - order[b.status] || b.durationMs - a.durationMs);
	const body: NativeNode[] = sorted.map(job => describeJob(job, isPartial));
	return {
		head,
		tone: counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success",
		body,
	};
}

const waitResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render a background-job snapshot. */
export const waitToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	activitySummary(): ToolActivitySummary {
		return { label: "Wait", detail: "Background work" };
	},
	renderCall: waitRenderCall,
	describeCall(): NativeToolView {
		return { head: toolHead("Wait"), inline: true };
	},
	describeResult(
		result: ToolRenderResult<CoordinationDetails>,
		options: RenderResultOptions,
	): NativeToolView | undefined {
		return waitResultMemo.get(result, [options.isPartial], () => {
			if (result.isError) return errorView("Wait", resultText(result));
			const details = result.details;
			if (details?.interrupted) {
				return { head: toolHead("Wait", "interrupted"), tone: "info", inline: true };
			}
			return describeJobsResult(result, options.isPartial);
		});
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (result.details?.interrupted && !result.isError) {
			return new Text(renderStatusLine({ icon: "info", title: "Wait", meta: ["interrupted"] }, uiTheme), 0, 0);
		}
		return jobsRenderResult(result, options, uiTheme);
	},
} satisfies ToolRenderer<object, CoordinationDetails>;

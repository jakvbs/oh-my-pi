import type { AsyncJob } from "./job-manager";

/**
 * Line shapes that compilers, test runners and runtimes print when something
 * failed. Anchored at line start where the tool prints them there, so prose
 * that merely mentions an error does not wake the agent.
 */
const ERROR_LINE_PATTERNS: readonly RegExp[] = [
	/^\s*(?:error(?:\[[A-Z]?\d+\])?|fatal|ERROR|FATAL|panic):/,
	/\berror TS\d+:/,
	/^\s*(?:FAIL|FAILED)\b/,
	/^\s*\(fail\)/,
	/\bpanicked at\b/,
	/^Traceback \(most recent call last\):/,
	/^npm ERR!/,
	/^##\[error\]/,
	/\bSegmentation fault\b/,
];

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 5;
const STALL_TAIL_LINES = 10;
/** Output changes a job must show while watched before its silence counts as a stall. */
const STALL_MIN_CHANGES = 2;
/**
 * Silence must also outlast this many of the job's longest gap between
 * changes, so a watcher that redraws every few minutes is not stalled
 * between two redraws.
 */
const STALL_GAP_FACTOR = 3;

export type OutputAlert =
	| { kind: "error"; jobId: string; fragment: string }
	| { kind: "stall"; jobId: string; fragment: string; silentMs: number };

/** What a running job's output looked like when the watch last sampled it. */
export interface OutputActivity {
	printed: boolean;
	changedAt: number;
}

interface WatchedOutput {
	lines: string[];
	changedAt: number;
	changes: number;
	longestGapMs: number;
	stallReported: boolean;
	/** Error lines already woken for; a redrawn frame repeats them verbatim. */
	alertedErrors: Set<string>;
}

/** Lines of `text` the job finished writing; a trailing partial line is still being written. */
function completeLines(text: string): string[] {
	const lines = text.replace(ANSI_ESCAPE, "").split("\n");
	lines.pop();
	return lines;
}

/**
 * Lines of `next` that `previous` did not show. A preview is a sliding tail
 * window, so the longest suffix of `previous` that starts `next` marks what
 * was already scanned.
 */
export function linesAfter(previous: readonly string[], next: readonly string[]): string[] {
	for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap--) {
		let matches = true;
		for (let i = 0; i < overlap; i++) {
			if (previous[previous.length - overlap + i] !== next[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return next.slice(overlap);
	}
	return [...next];
}

export function isErrorLine(line: string): boolean {
	return ERROR_LINE_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Tracks what each running bash job printed across `wait` calls, so a wait
 * wakes once per distinct error line and once per silent stretch, never again
 * for output the agent was already woken for. Silence is a stall only for a
 * job that kept printing while watched: a job silent by design (output
 * redirected, a quiet build step) gives no evidence that it is stuck.
 */
export class OutputAlertWatch {
	readonly #seen = new Map<string, WatchedOutput>();

	constructor(readonly stallMs: number) {}

	/** The first alert among `jobs`, recording what was scanned. */
	check(jobs: readonly AsyncJob[], now: number): OutputAlert | undefined {
		for (const job of jobs) {
			if (job.type !== "bash" || job.status !== "running") continue;
			const alert = this.#checkJob(job, now);
			if (alert) return alert;
		}
		return undefined;
	}

	/** Whether `jobId` has printed anything and when its output last changed, as of the last check. */
	activity(jobId: string): OutputActivity | undefined {
		const watched = this.#seen.get(jobId);
		return watched && { printed: watched.lines.length > 0, changedAt: watched.changedAt };
	}

	#checkJob(job: AsyncJob, now: number): OutputAlert | undefined {
		const lines = completeLines(job.progressText ?? "");
		const watched = this.#seen.get(job.id);
		if (!watched) {
			const fresh: WatchedOutput = {
				lines,
				changedAt: now,
				changes: 0,
				longestGapMs: 0,
				stallReported: false,
				alertedErrors: new Set(),
			};
			this.#seen.set(job.id, fresh);
			return this.#errorIn(job.id, fresh, lines);
		}
		const fresh = linesAfter(watched.lines, lines);
		if (fresh.length > 0) {
			watched.longestGapMs = Math.max(watched.longestGapMs, now - watched.changedAt);
			watched.changes++;
			watched.lines = lines;
			watched.changedAt = now;
			watched.stallReported = false;
			return this.#errorIn(job.id, watched, fresh);
		}
		const silentMs = now - watched.changedAt;
		if (
			watched.stallReported ||
			watched.changes < STALL_MIN_CHANGES ||
			silentMs < Math.max(this.stallMs, STALL_GAP_FACTOR * watched.longestGapMs)
		) {
			return undefined;
		}
		watched.stallReported = true;
		const tail = lines.slice(-STALL_TAIL_LINES).join("\n");
		return { kind: "stall", jobId: job.id, fragment: tail, silentMs };
	}

	#errorIn(jobId: string, watched: WatchedOutput, fresh: readonly string[]): OutputAlert | undefined {
		let hit = -1;
		for (let i = 0; i < fresh.length; i++) {
			const line = fresh[i].trim();
			if (!isErrorLine(fresh[i]) || watched.alertedErrors.has(line)) continue;
			watched.alertedErrors.add(line);
			if (hit === -1) hit = i;
		}
		if (hit === -1) return undefined;
		const { lines } = watched;
		const at = lines.length - fresh.length + hit;
		const fragment = lines.slice(Math.max(0, at - CONTEXT_BEFORE), at + CONTEXT_AFTER + 1).join("\n");
		return { kind: "error", jobId, fragment };
	}

	/** Drops jobs that no longer run, so the map does not grow with the session. */
	forget(runningIds: ReadonlySet<string>): void {
		for (const id of this.#seen.keys()) if (!runningIds.has(id)) this.#seen.delete(id);
	}
}

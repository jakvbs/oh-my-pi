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

export type OutputAlert =
	| { kind: "error"; jobId: string; fragment: string }
	| { kind: "stall"; jobId: string; fragment: string; silentMs: number };

interface WatchedOutput {
	lines: string[];
	changedAt: number;
	stallReported: boolean;
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
 * wakes once per new error line and once per silent stretch, never again for
 * output the agent was already woken for.
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

	#checkJob(job: AsyncJob, now: number): OutputAlert | undefined {
		const lines = completeLines(job.progressText ?? "");
		const watched = this.#seen.get(job.id);
		if (!watched) {
			this.#seen.set(job.id, { lines, changedAt: job.startTime, stallReported: false });
			return this.#errorIn(job.id, lines, lines);
		}
		const fresh = linesAfter(watched.lines, lines);
		if (fresh.length > 0) {
			watched.lines = lines;
			watched.changedAt = now;
			watched.stallReported = false;
			return this.#errorIn(job.id, lines, fresh);
		}
		const silentMs = now - watched.changedAt;
		if (watched.stallReported || silentMs < this.stallMs) return undefined;
		watched.stallReported = true;
		const tail = lines.slice(-STALL_TAIL_LINES).join("\n");
		return { kind: "stall", jobId: job.id, fragment: tail, silentMs };
	}

	#errorIn(jobId: string, lines: readonly string[], fresh: readonly string[]): OutputAlert | undefined {
		const hit = fresh.findIndex(isErrorLine);
		if (hit === -1) return undefined;
		const at = lines.length - fresh.length + hit;
		const fragment = lines.slice(Math.max(0, at - CONTEXT_BEFORE), at + CONTEXT_AFTER + 1).join("\n");
		return { kind: "error", jobId, fragment };
	}

	/** Drops jobs that no longer run, so the map does not grow with the session. */
	forget(runningIds: ReadonlySet<string>): void {
		for (const id of this.#seen.keys()) if (!runningIds.has(id)) this.#seen.delete(id);
	}
}

import { isErrorLine } from "../async/output-alert";

/** A status redraw needs this many frames before earlier ones count as superseded. */
const MIN_FRAMES = 3;
const MAX_KEPT_ERROR_LINES = 5;
const MIDDLE_ELISION_MARKER = /^\[…\d+(?:ln|B) elided…\]$/;

export interface FoldedRedraws {
	/** The last frame and everything printed after it. */
	text: string;
	/** Error lines from the elided frames that the kept text does not repeat. */
	errorLines: string[];
}

/**
 * Off a terminal, status watchers such as `gh run watch` reprint their whole
 * frame every interval, and each frame starts with the output's first line.
 * When the capture must drop output anyway, the latest frame is worth more
 * than the head: earlier frames only show states the latest one supersedes.
 * Returns undefined unless the captured text (head, elision marker, tail)
 * holds at least {@link MIN_FRAMES} frames and the last one starts in the tail.
 */
export function foldRedraws(output: string): FoldedRedraws | undefined {
	const lines = output.split("\n");
	const header = lines[0];
	if (!header?.trim()) return undefined;
	let frames = 0;
	let lastFrame = -1;
	let marker = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === header) {
			frames++;
			lastFrame = i;
		} else if (MIDDLE_ELISION_MARKER.test(lines[i])) {
			marker = i;
		}
	}
	if (frames < MIN_FRAMES || lastFrame < marker) return undefined;
	const kept = lines.slice(lastFrame);
	const keptLines = new Set(kept.map(line => line.trim()));
	const errorLines = new Set<string>();
	for (const line of lines.slice(0, lastFrame)) {
		const trimmed = line.trim();
		if (isErrorLine(line) && !keptLines.has(trimmed)) errorLines.add(trimmed);
	}
	return { text: kept.join("\n"), errorLines: [...errorLines].slice(0, MAX_KEPT_ERROR_LINES) };
}

export function formatRedrawNotice(folded: FoldedRedraws): string {
	const notice = "[Earlier redraws of this status output elided; showing the last redraw and what followed it.]";
	if (folded.errorLines.length === 0) return notice;
	return [notice, "Error lines from the elided redraws:", ...folded.errorLines.map(line => `  ${line}`)].join("\n");
}

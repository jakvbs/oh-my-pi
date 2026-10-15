import { tokenizeShellSegments } from "./shell-tokenize";

const SECONDS_PER_UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Longest literal `sleep` among the command's segments, in seconds; 0 when no
 * segment is a `sleep` with only literal durations (GNU `sleep` sums them).
 */
export function longestSleepSeconds(command: string): number {
	let longest = 0;
	for (const [program, ...args] of tokenizeShellSegments(command)) {
		if (program !== "sleep" || args.length === 0) continue;
		let total = 0;
		for (const arg of args) {
			const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
			if (arg === "infinity") total = Infinity;
			else if (match) total += Number(match[1]) * SECONDS_PER_UNIT[match[2]];
			else {
				total = 0;
				break;
			}
		}
		longest = Math.max(longest, total);
	}
	return longest;
}

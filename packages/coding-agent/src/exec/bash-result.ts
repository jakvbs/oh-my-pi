import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { BashExecution, BashCapturedOutput } from "@oh-my-pi/pi-tui/tools/bash-result";
import type { OutputArtifactError, OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";

/** Public RPC/extension shape retained for callers supplying their own results. */
export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	workingDir?: string;
	images?: ImageContent[];
}

export interface CapturedBashResult extends BashResult, OutputSummary {
	execution: BashExecution;
}

export function completeBashResult(
	result: BashResult,
	incomplete?: "source-truncated" | "snapshot-unavailable",
): CapturedBashResult {
	const status: BashExecution["status"] = result.timedOut
		? { kind: "timedOut" }
		: result.cancelled
			? { kind: "cancelled" }
			: result.exitCode === undefined
				? { kind: "unknown" }
				: { kind: "exited", exitCode: result.exitCode };
	let output: BashCapturedOutput;
	if (result.artifactError) {
		output = { kind: "unavailable", reason: result.artifactError };
	} else if (!result.artifactId) {
		output = { kind: "unavailable", reason: incomplete === "snapshot-unavailable" ? incomplete : "not-configured" };
	} else if (incomplete) {
		output = { kind: "partial", artifactId: result.artifactId, reason: incomplete };
	} else if (result.artifactElidedBytes) {
		output = {
			kind: "partial",
			artifactId: result.artifactId,
			reason: "artifact-cap",
			elidedBytes: result.artifactElidedBytes,
		};
	} else if (status.kind !== "exited") {
		output = { kind: "partial", artifactId: result.artifactId, reason: "interrupted" };
	} else {
		output = { kind: "complete", artifactId: result.artifactId };
	}
	return { ...result, execution: { status, output } };
}

import type { OutputArtifactError } from "./streaming-output";

export type BashStatus =
	| { kind: "exited"; exitCode: number }
	| { kind: "timedOut" }
	| { kind: "cancelled" }
	| { kind: "unknown" };

export type BashCapturedOutput =
	| { kind: "complete"; artifactId: string }
	| {
			kind: "partial";
			artifactId: string;
			reason: "artifact-cap" | "source-truncated" | "snapshot-unavailable" | "interrupted";
			elidedBytes?: number;
	  }
	| { kind: "unavailable"; reason: OutputArtifactError | "not-configured" | "allocation" | "snapshot-unavailable" };

export interface BashExecution {
	status: BashStatus;
	output: BashCapturedOutput;
}

export function formatBashCaptureNotice(output: BashCapturedOutput): string {
	if (output.kind === "unavailable") return `[Captured output unavailable: ${output.reason}]`;
	const partial = output.kind === "partial" ? `[Capture incomplete: ${output.reason}]\n` : "";
	return `${partial}[raw output: artifact://${output.artifactId}]`;
}

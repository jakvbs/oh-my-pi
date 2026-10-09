import { prompt } from "@oh-my-pi/pi-utils";
import annotationsTemplate from "./prompts/annotations.md" with { type: "text" };
import type { CodeReviewAnnotation } from "@oh-my-pi/pi-tui/overlays/annotation-types";

export interface FormatCodeReviewAnnotationsOptions {
	supplementalInstructions?: string;
}

type RenderedAnnotation = CodeReviewAnnotation & {
	pathLabel: string;
	lineLabel?: string;
	isLine: boolean;
};

function formatPathLabel(annotation: CodeReviewAnnotation): string {
	return annotation.occurrence > 1 ? `${annotation.path} (${annotation.occurrence})` : annotation.path;
}

function formatLineLabel(annotation: Extract<CodeReviewAnnotation, { scope: "line" }>): string {
	if (annotation.oldLine !== undefined && annotation.newLine !== undefined) {
		return `old ${annotation.oldLine}, new ${annotation.newLine}`;
	}
	if (annotation.newLine !== undefined) return `new ${annotation.newLine}`;
	if (annotation.oldLine !== undefined) return `old ${annotation.oldLine}`;
	return "hunk";
}

/** Formats exact annotations for an editor paste. */
export function formatCodeReviewAnnotations(
	annotations: readonly CodeReviewAnnotation[],
	options: FormatCodeReviewAnnotationsOptions,
): string | undefined {
	const supplementalInstructions = options.supplementalInstructions?.trim();
	if (annotations.length === 0 && !supplementalInstructions) return undefined;
	const renderedAnnotations: RenderedAnnotation[] = annotations.map(annotation =>
		annotation.scope === "line"
			? {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					lineLabel: formatLineLabel(annotation),
					isLine: true,
				}
			: {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					isLine: false,
				},
	);
	return prompt.render(annotationsTemplate, {
		annotations: renderedAnnotations,
		supplementalInstructions,
	});
}

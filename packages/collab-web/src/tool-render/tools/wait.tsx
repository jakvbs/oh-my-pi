import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { jobRenderer } from "./job";

function Summary(props: ToolRenderProps): ReactNode {
	return <jobRenderer.Summary {...props} args={{ poll: [] }} />;
}

function Body(props: ToolRenderProps): ReactNode {
	return jobRenderer.Body ? <jobRenderer.Body {...props} args={{ poll: [] }} /> : null;
}

export const waitRenderer: ToolRenderer = { Summary, Body };

import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const CONTEXT_TOOL_NAMES = ["read", "glob", "grep", "lsp", "ast_grep"] as const;
export const MAX_CONTEXT_TOOL_CALLS = 24;

export type ContextToolMode = "none" | "planner" | "reviewer";

const CONTEXT_TOOL_NAME_LOOKUP: Record<(typeof CONTEXT_TOOL_NAMES)[number], true> = {
	read: true,
	glob: true,
	grep: true,
	lsp: true,
	ast_grep: true,
};
const READ_ONLY_LSP_ACTIONS: Record<string, true> = {
	capabilities: true,
	definition: true,
	diagnostics: true,
	hover: true,
	implementation: true,
	references: true,
	status: true,
	symbols: true,
	type_definition: true,
};
const recordSchema = z.record(z.string(), z.unknown());

export function authorizeContextToolCall({
	callCount,
	cwd,
	input,
	mode,
	roots,
	toolName,
}: {
	callCount: number;
	cwd: string;
	input: unknown;
	mode: ContextToolMode;
	roots: string[];
	toolName: string;
}) {
	if (mode === "none") return "Context tools are disabled for this prompt";
	if (!(toolName in CONTEXT_TOOL_NAME_LOOKUP)) return `Tool ${toolName} is outside the read-only context policy`;
	if (callCount > MAX_CONTEXT_TOOL_CALLS) return `Context tool budget exceeded (${MAX_CONTEXT_TOOL_CALLS} calls)`;

	const record = recordSchema.parse(input ?? {});
	if (toolName === "lsp") {
		const action = typeof record.action === "string" ? record.action.toLowerCase() : "";
		if (!(action in READ_ONLY_LSP_ACTIONS)) return `LSP action ${action || "<missing>"} is not read-only`;
	}

	for (const target of toolTargets(toolName, record)) {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return `Context tool target must be a local path: ${target}`;
		const absoluteTarget = resolve(cwd, target);
		if (!roots.some(root => isWithin(resolve(root), absoluteTarget))) {
			return `Context tool target is outside allowed roots: ${target}`;
		}
	}
	return null;
}

function toolTargets(toolName: string, input: Record<string, unknown>) {
	const raw = toolName === "lsp" ? input.file : input.path;
	if (typeof raw !== "string" || raw.length === 0) return [];
	return toolName === "read" || toolName === "lsp" ? [raw] : raw.split(";").filter(Boolean);
}

function isWithin(root: string, candidate: string) {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

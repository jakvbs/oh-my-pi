import { isAbsolute, relative, resolve } from "node:path";

export const CONTEXT_TOOL_NAMES = ["read", "lsp", "ast_grep"] as const;
export const MAX_CONTEXT_TOOL_CALLS = 4;

export type ContextToolMode = "none" | "read_only";

const READ_ONLY_LSP_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

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
	if (mode !== "read_only") return "Context tools are disabled for this prompt";
	if (!CONTEXT_TOOL_NAMES.includes(toolName as (typeof CONTEXT_TOOL_NAMES)[number])) {
		return `Tool ${toolName} is outside the read-only context policy`;
	}
	if (callCount > MAX_CONTEXT_TOOL_CALLS) {
		return `Context tool budget exceeded (${MAX_CONTEXT_TOOL_CALLS} calls)`;
	}

	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	if (toolName === "lsp") {
		const action = typeof record.action === "string" ? record.action.toLowerCase() : "";
		if (!READ_ONLY_LSP_ACTIONS.has(action)) return `LSP action ${action || "<missing>"} is not read-only`;
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
	return toolName === "ast_grep" ? raw.split(";").filter(Boolean) : [raw];
}

function isWithin(root: string, candidate: string) {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

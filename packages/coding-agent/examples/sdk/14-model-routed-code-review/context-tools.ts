import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const CONTEXT_TOOL_NAMES = ["read", "lsp", "ast_grep"] as const;
export const PLANNER_TOOL_NAMES = [...CONTEXT_TOOL_NAMES, "task"] as const;
const CONTEXT_TOOL_NAME_SET = new Set<string>(CONTEXT_TOOL_NAMES);
export const MAX_CONTEXT_TOOL_CALLS = 4;
export const MAX_PLANNER_CONTEXT_TOOL_CALLS = 12;

export type ContextToolMode = "none" | "read_only" | "semantic_planning";

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

const recordSchema = z.record(z.string(), z.unknown());
const taskInputSchema = z
	.object({
		name: z.string().optional(),
		agent: z.literal("scout"),
		task: z.string().min(1),
		isolated: z.boolean().optional(),
	})
	.strict();

export function authorizeContextToolCall({
	callCount,
	cwd,
	input,
	mode,
	roots,
	taskCallCount = 0,
	toolName,
}: {
	callCount: number;
	cwd: string;
	input: unknown;
	mode: ContextToolMode;
	roots: string[];
	taskCallCount?: number;
	toolName: string;
}) {
	if (mode === "none") return "Context tools are disabled for this prompt";
	if (toolName === "task") {
		if (mode !== "semantic_planning") return "Subagents are disabled for this prompt";
		if (taskCallCount > 1) return "Semantic planner may invoke exactly one scout";
		const task = taskInputSchema.safeParse(input);
		if (!task.success || task.data.agent !== "scout") return "Semantic planner may invoke only the scout agent";
		return null;
	}
	if (!CONTEXT_TOOL_NAME_SET.has(toolName)) {
		return `Tool ${toolName} is outside the read-only context policy`;
	}
	const maxCalls = mode === "semantic_planning" ? MAX_PLANNER_CONTEXT_TOOL_CALLS : MAX_CONTEXT_TOOL_CALLS;
	if (callCount - taskCallCount > maxCalls) return `Context tool budget exceeded (${maxCalls} calls)`;

	const record = recordSchema.parse(input ?? {});
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

import { expect, test } from "bun:test";
import { authorizeContextToolCall, MAX_CONTEXT_TOOL_CALLS } from "./context-tools";

const cwd = "/repo";
const roots = ["/repo/src"];

function authorize(
	toolName: string,
	input: unknown,
	callCount = 1,
	mode: "none" | "planner" | "reviewer" = "reviewer",
) {
	return authorizeContextToolCall({ callCount, cwd, input, mode, roots, toolName });
}

test("allows bounded read-only filesystem exploration", () => {
	expect(authorize("read", { path: "/repo/src/a.ts:1-20" })).toBeNull();
	expect(authorize("glob", { path: "/repo/src/**/*.ts" })).toBeNull();
	expect(authorize("grep", { path: "/repo/src;/repo/src-tests", pattern: "TODO" })).toContain("outside allowed roots");
	expect(authorize("grep", { path: "/repo/src;/repo/src/lib", pattern: "TODO" })).toBeNull();
	expect(authorize("ast_grep", { path: "/repo/src", pat: "$A" })).toBeNull();
	expect(authorize("lsp", { action: "references", file: "/repo/src/a.ts" })).toBeNull();
});

test("blocks writes, remote paths, unsafe LSP actions, and excessive calls", () => {
	expect(authorize("write", { path: "/repo/src/a.ts" })).toContain("outside the read-only context policy");
	expect(authorize("task", { agent: "worker", task: "inspect" }, 1, "planner")).toContain(
		"outside the read-only context policy",
	);
	expect(authorize("read", { path: "https://example.com/source.ts" })).toContain("must be a local path");
	expect(authorize("read", { path: "/repo/private.ts" })).toContain("outside allowed roots");
	expect(authorize("lsp", { action: "rename", file: "/repo/src/a.ts" })).toContain("not read-only");
	expect(authorize("read", { path: "/repo/src/a.ts" }, MAX_CONTEXT_TOOL_CALLS + 1)).toContain("budget exceeded");
	expect(authorize("read", { path: "/repo/src/a.ts" }, 1, "none")).toContain("disabled");
});

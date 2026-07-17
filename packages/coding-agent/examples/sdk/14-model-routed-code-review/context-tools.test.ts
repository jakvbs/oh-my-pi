import { expect, test } from "bun:test";
import { authorizeContextToolCall } from "./context-tools";

const cwd = "/workspace/project";
const roots = [cwd];

function authorize(
	toolName: string,
	input: unknown,
	callCount = 1,
	mode: "none" | "read_only" | "semantic_planning" = "read_only",
	taskCallCount = 0,
) {
	return authorizeContextToolCall({ callCount, cwd, input, mode, roots, taskCallCount, toolName });
}

test("allows only bounded read-only context tools inside configured roots", () => {
	expect(authorize("read", { path: "src/service.ts:10-30" })).toBeNull();
	expect(authorize("ast_grep", { pat: "$CALL($$$ARGS)", path: "src" })).toBeNull();
	expect(authorize("lsp", { action: "references", file: "src/service.ts", line: 10, symbol: "load" })).toBeNull();
	expect(authorize("lsp", { action: "rename", file: "src/service.ts", line: 10, symbol: "load" })).toContain(
		"not read-only",
	);
	expect(authorize("read", { path: "/workspace/secrets.txt" })).toContain("outside allowed roots");
	expect(authorize("web_search", { query: "service" })).toContain("outside the read-only context policy");
	expect(authorize("read", { path: "src/service.ts" }, 5)).toContain("budget exceeded");
	expect(authorize("read", { path: "src/service.ts" }, 1, "none")).toContain("disabled");
});

test("allows exactly one scout task for semantic planning", () => {
	expect(authorize("task", { agent: "scout", task: "Plan semantic units" }, 1, "semantic_planning", 1)).toBeNull();
	expect(authorize("task", { agent: "task", task: "Plan semantic units" }, 1, "semantic_planning", 1)).toContain(
		"only the scout",
	);
	expect(authorize("task", { agent: "scout", task: "Plan again" }, 2, "semantic_planning", 2)).toContain(
		"exactly one scout",
	);
	expect(authorize("task", { agent: "scout", task: "Plan semantic units" })).toContain("disabled");
});

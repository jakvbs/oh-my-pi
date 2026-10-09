import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Unknown stale keys are stripped rather than rejecting otherwise valid calls.

describe("oneLineLabel", () => {
	it("returns short text unchanged", () => {
		expect(oneLineLabel("DB migration specialist")).toBe("DB migration specialist");
	});

	it("collapses control and zero-width characters that \\s alone misses", () => {
		// U+0085 (NEL) and U+200B (zero-width space) are NOT matched by \s, so a
		// bare replace(/\s+/) would leak them into a prompt/roster field.
		const out = oneLineLabel("Auth\u0085flow\u200breviewer");
		expect(out).toBe("Auth flow reviewer");
		expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
	});

	it("respects a minimal cap without a negative-slice blowup", () => {
		expect(oneLineLabel("abcdef", 1)).toBe("…");
		expect(oneLineLabel("abcdef", 0)).toBe("…");
	});

	it("truncates on a code-point boundary without splitting a surrogate pair", () => {
		// The cut would land mid-emoji at the default cap; the result must stay
		// well-formed (a lone surrogate makes encodeURIComponent throw).
		const out = oneLineLabel(`${"a".repeat(78)}😀tail`);
		expect(out.endsWith("…")).toBe(true);
		expect(() => encodeURIComponent(out)).not.toThrow();
	});
});

/** Narrow a parsed batch payload to its items; fails the test on any other shape. */
function parsedItems(parsed: unknown): Array<Record<string, unknown>> {
	if (parsed instanceof type.errors) throw new Error(`schema rejected input: ${parsed.summary}`);
	if (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks)) {
		return parsed.tasks;
	}
	throw new Error("expected a batch parse result with tasks[]");
}

describe("task wire schema", () => {
	it("accepts the flat { name, agent, task } shape", () => {
		const parsed = taskSchema({ name: "AuthLoader", agent: "scout", task: "map the auth flow", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.name).toBe("AuthLoader");
			expect(parsed.agent).toBe("scout");
			expect(parsed.task).toBe("map the auth flow");
		}
	});

	it("rejects a missing agent", () => {
		const parsed = taskSchema({ task: "x", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("deletes stale caller keys (role, description) instead of rejecting", () => {
		const parsed = taskSchema({
			agent: "task",
			task: "x",
			solutionSpace: "c",
			role: "Rust specialist",
			description: "stale ui label",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("role" in parsed).toBe(false);
			expect("description" in parsed).toBe(false);
			expect(parsed.task).toBe("x");
		}
	});

	it("requires an agent on every batch item on the fast path", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const parsed = batch({ context: "ctx", tasks: [{ name: "DbMigrator", task: "x", solutionSpace: "c" }] });
		expect(parsed instanceof type.errors).toBe(true);
		const items = parsedItems(
			batch({ context: "ctx", tasks: [{ agent: "worker", name: "DbMigrator", task: "x", solutionSpace: "c" }] }),
		);
		expect(items[0]?.agent).toBe("worker");
		expect(items[0]?.name).toBe("DbMigrator");
	});

	it("requires an agent on every batch item with dynamic schema fields", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true, effortEnabled: true });
		const parsed = batch({ context: "ctx", tasks: [{ task: "x", solutionSpace: "c", effort: "lo" }] });
		expect(parsed instanceof type.errors).toBe(true);
		const items = parsedItems(
			batch({ context: "ctx", tasks: [{ agent: "reviewer", task: "x", solutionSpace: "c", effort: "lo" }] }),
		);
		expect(items[0]?.agent).toBe("reviewer");
	});

	it("deletes stale keys from batch items", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const items = parsedItems(
			batch({
				context: "ctx",
				tasks: [{ agent: "worker", task: "x", solutionSpace: "c", role: "DB migration specialist" }],
			}),
		);
		const item = items[0] ?? {};
		expect("role" in item).toBe(false);
		expect(item.task).toBe("x");
	});
});

// Contract: `agent` and `name` shape the spawned subagent's identity and the
// task text is the work being authorized, so an approval-gated session must
// surface them before the user authorizes the spawn.
describe("task approval details surface the dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makeTool(): Promise<TaskTool> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		return TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": true }),
			getSessionFile: () => null,
		} as unknown as ToolSession);
	}

	it("surfaces agent, name, and task for a flat spawn", async () => {
		const tool = await makeTool();
		const lines = tool.formatApprovalDetails({
			agent: "reviewer",
			name: "ReviewAuth",
			task: "audit the auth module",
		});
		expect(lines).toContain("Agent: reviewer");
		expect(lines).toContain("Name: ReviewAuth");
		expect(lines).toContain("Task:\naudit the auth module");
	});

	it("summarizes a homogeneous batch with explicit agents", async () => {
		const tool = await makeTool();
		const lines = tool.formatApprovalDetails({
			context: "shared background",
			tasks: [
				{
					name: "DbMigrator",
					agent: "scout",
					task: "migrate the schema",
				},
				{ agent: "scout", task: "second item" },
			],
		});
		expect(lines).toContain("Context:\nshared background");
		expect(lines).toContain("Batch agents: scout ×2");
		expect(lines).toContain("Name: DbMigrator");
		expect(lines).toContain("Agent: scout");
		expect(lines).toContain("Task:\nmigrate the schema");
		expect(lines).toContain("+1 more task");
	});

	it("summarizes mixed effective agents and safely renders partial batch items", async () => {
		const tool = await makeTool();
		const lines = tool.formatApprovalDetails({
			tasks: [
				{ name: "UnspecifiedAgent", task: "map the flow" },
				{ agent: " reviewer ", task: "review it" },
			],
		});
		expect(lines).toContain("Batch agents: unspecified ×1, reviewer ×1");
		expect(lines).toContain("Name: UnspecifiedAgent");
		expect(lines).toContain("Agent: unspecified");
		expect(lines.join("\n")).not.toContain("undefined");

		expect(() => tool.formatApprovalDetails({ tasks: [undefined, { agent: "reviewer" }] })).not.toThrow();
	});
});

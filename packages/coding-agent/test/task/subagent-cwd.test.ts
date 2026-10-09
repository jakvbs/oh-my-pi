import { describe, expect, it } from "bun:test";
import { resolveSubagentCwd } from "@oh-my-pi/pi-coding-agent/task/executor";

describe("resolveSubagentCwd", () => {
	it("resolves the agent cwd inside the isolation worktree", () => {
		expect(resolveSubagentCwd("/repo", "/wt", "packages/api")).toBe("/wt/packages/api");
	});

	it("rejects an isolated agent cwd outside the worktree", () => {
		expect(() => resolveSubagentCwd("/repo", "/wt", "/repo/packages/api")).toThrow("leaves the isolation worktree");
	});
});

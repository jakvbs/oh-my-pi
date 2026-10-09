import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const researcher: AgentDefinition = {
	name: "researcher",
	description: "Read-only research.",
	systemPrompt: "Research.",
	source: "project",
};

describe("task agent capability descriptions", () => {
	it("treats an agent without a tool allowlist as able to edit", () => {
		expect(isReadOnlyAgent(researcher)).toBe(false);
	});

	it("keeps `wait` read-only while any exec-tier tool disqualifies the agent", () => {
		expect(isReadOnlyAgent({ ...researcher, tools: ["read", "grep", "wait", "yield"] })).toBe(true);
		expect(isReadOnlyAgent({ ...researcher, tools: ["read", "grep", "wait", "bash"] })).toBe(false);
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import type { AgentDefinition } from "../../src/task/types";
import { getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "user",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.enabled": false,
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check", solutionSpace: "c" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check", solutionSpace: "c" });
	});

	it("filters the agent list to the restricted spawn policy in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder"));
		const description = tool.description;

		expect(description).toContain("- `fact-finder`: Find facts.");
		expect(description).not.toContain("- `oracle`:");
	});
});

describe("task tool without a default agent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requires an explicit agent in the unrestricted description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("*"));

		expect(tool.description).toContain("`agent` is required.");
		expect(tool.description).not.toContain("Omit `agent` only for default");
	});

	it("rejects a spawn without an agent and lists the available agents", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("*"));
		const result = await tool.execute("tc", {
			context: "shared",
			tasks: [{ name: "First", task: "check", solutionSpace: "c" }],
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("Missing agent: specify which agent to spawn.");
		expect(text).toContain("Available: fact-finder.");
	});
});

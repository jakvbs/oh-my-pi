import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, type MockResponseSource, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSessionToYield } from "@oh-my-pi/pi-coding-agent/session/run-to-yield";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

registerMockApi();

const sessions: AgentSession[] = [];
const roots: TempDir[] = [];
const registries: ModelRegistry[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) registry.authStorage.close();
	for (const root of roots.splice(0)) root.removeSync();
});

const outputSchema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};

async function closedBookSession(responses: MockResponseSource, toolNames: string[] = []) {
	const root = TempDir.createSync("@pi-run-to-yield-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(auth);
	registries.push(modelRegistry);
	const model = createMockModel({ responses });
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		hasUI: false,
		bindProcessState: false,
		requireYieldTool: true,
		restrictToolNames: true,
		toolNames,
		outputSchema,
		outputSchemaMode: "strict",
	});
	sessions.push(session);
	return { model, session };
}

const yieldCall = (data: unknown) => ({
	content: [{ type: "toolCall" as const, id: "yield-1", name: "yield", arguments: { data } }],
	stopReason: "toolUse" as const,
});

describe("runSessionToYield", () => {
	it("returns the yielded data that matches the output schema", async () => {
		const { session } = await closedBookSession([yieldCall({ answer: "42" })]);
		expect(await runSessionToYield(session, "Answer.", { outputSchema, outputSchemaMode: "strict" })).toEqual({
			kind: "yielded",
			data: { answer: "42" },
		});
	});

	it("reports a provider error on a reminder turn instead of a missing yield, without further reminders", async () => {
		const { model, session } = await closedBookSession([
			{ content: [{ type: "text", text: "Done." }] },
			{ stopReason: "error", errorMessage: "400 invalid_request_error: tools.0.name is invalid" },
		]);
		const outcome = await runSessionToYield(session, "Answer.", { outputSchema, outputSchemaMode: "strict" });
		expect(outcome.kind).toBe("provider-error");
		expect(outcome.kind !== "yielded" && outcome.message).toContain("tools.0.name is invalid");
		expect(model.calls.length).toBe(2);
	});
});

describe("createAgentSession with restrictToolNames", () => {
	it("rejects a tool name that matches no tool instead of starting without it", async () => {
		await expect(closedBookSession([], ["reed"])).rejects.toThrow("reed");
	});
});

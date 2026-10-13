import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// Sessions written before the `task` tool was removed still carry its calls and results; resuming
// one must not throw, and the dead tool must not come back.
describe("resuming a session whose history calls a removed tool", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("replays the old task call and result and reports stats without a task tool", async () => {
		using tempDir = TempDir.createSync("@pi-legacy-task-history-");
		const mock = createMockModel({ provider: "anthropic" });
		const authStorage = createInMemoryAuthStorage();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const timestamp = Date.now();
		sessionManager.appendMessage({ role: "user", content: "delegate it", timestamp });
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "toolu_legacy_task", name: "task", arguments: { tasks: [{ name: "Probe" }] } },
			],
			api: mock.api,
			provider: mock.provider,
			model: mock.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_legacy_task",
			toolName: "task",
			content: [{ type: "text", text: "child finished" }],
			details: { results: [{ id: "Probe", usage: { input: 5, output: 5, totalTokens: 10 } }] },
			isError: false,
			timestamp,
		});

		({ session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated(),
			sessionManager,
			model: mock.model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			toolNames: ["read"],
		}));

		expect(session.messages.some(message => message.role === "toolResult" && message.toolName === "task")).toBe(true);
		expect(session.getAllToolNames()).not.toContain("task");
		expect(() => session?.getSessionStats()).not.toThrow();
		authStorage.close();
	});
});

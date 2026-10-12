import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SystemPromptSource } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

async function start(tempDir: TempDir, sessionManager: SessionManager, systemPromptSource?: SystemPromptSource) {
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${Bun.nanoseconds()}.db`));
	authStorage.keys.setRuntime("openai", "test-key");
	try {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager,
			settings: Settings.isolated({ "async.enabled": false, "marketplace.autoUpdate": "off" }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...(systemPromptSource ? { systemPromptSource } : {}),
		});
		const systemPrompt = session.systemPrompt.join("\n");
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage(makeAssistantMessage());
		await session.dispose();
		return systemPrompt;
	} finally {
		authStorage.close();
	}
}

describe("--system-prompt across resume", () => {
	it("records the file and re-reads it when the session resumes without the flag", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-resume-");
		const role = tempDir.join("role.md");
		await Bun.write(role, "Answer with KIWI.");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));

		const first = await start(tempDir, sessionManager, { path: role });
		await Bun.write(role, "Answer with MANGO.");
		const resumed = await start(tempDir, await SessionManager.open(sessionManager.getSessionFile()!));

		expect([first.includes("Answer with KIWI."), resumed.includes("Answer with MANGO.")]).toEqual([true, true]);
	});

	it("refuses to resume when the recorded file is gone", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-gone-");
		const role = tempDir.join("role.md");
		await Bun.write(role, "Answer with KIWI.");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		await start(tempDir, sessionManager, { path: role });
		await Bun.file(role).delete();

		await expect(start(tempDir, await SessionManager.open(sessionManager.getSessionFile()!))).rejects.toThrow(
			`Cannot read the system prompt file ${role} recorded by this session`,
		);
	});
});

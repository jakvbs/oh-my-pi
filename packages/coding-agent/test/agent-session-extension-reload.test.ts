import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const probeTool: AgentTool = {
	name: "probe",
	label: "Probe",
	description: "Reload interception probe",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
};

describe("AgentSession extension reload", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("adds and removes extension tools and handlers without rebuilding the session", async () => {
		tempDir = TempDir.createSync("@pi-extension-reload-");
		const extensionPath = tempDir.join("reload-extension.ts");
		const initial = await loadExtensions([], tempDir.path());
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runner = new ExtensionRunner(
			initial.extensions,
			initial.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const wrappedProbe = new ExtensionToolWrapper(probeTool, runner);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [wrappedProbe] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: runner,
			toolRegistry: new Map([[probeTool.name, wrappedProbe]]),
			builtInToolNames: [probeTool.name],
			reloadExtensions: async () =>
				loadExtensions((await Bun.file(extensionPath).exists()) ? [extensionPath] : [], tempDir.path()),
		});

		await fs.writeFile(
			extensionPath,
			[
				"export default function (pi) {",
				"  pi.registerTool({",
				"    name: 'fresh_tool',",
				"    label: 'Fresh tool',",
				"    description: 'Added after startup',",
				"    parameters: pi.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: 'fresh' }] }; },",
				"  });",
				"  pi.on('tool_call', event => event.toolName === 'probe'",
				"    ? { block: true, reason: 'reloaded guard' }",
				"    : undefined);",
				"}",
			].join("\n"),
		);

		await session.reloadExtensions();

		expect(session.getToolByName("fresh_tool")).toBeDefined();
		await expect(session.getToolByName("probe")!.execute("probe", {})).rejects.toThrow("reloaded guard");

		await fs.rm(extensionPath);
		await session.reloadExtensions();

		expect(session.getToolByName("fresh_tool")).toBeUndefined();
		const result = await session.getToolByName("probe")!.execute("probe", {});
		expect(result.content).toEqual([{ type: "text", text: "executed" }]);
	});
});

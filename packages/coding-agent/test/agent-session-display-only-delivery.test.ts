import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

const REPORT_TYPE = "progress-report";
const REPORT_BODY = "DISPLAY_ONLY_REPORT_BODY";

describe("AgentSession displayOnly delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-display-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** One tool round that blocks until released, then a plain "Done." turn; every provider request is captured. */
	function createStreamingSession(sessionManager: SessionManager) {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const contexts: Context[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount++ === 0;
				const message: AssistantMessage = {
					role: "assistant",
					content: isFirstCall
						? [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }]
						: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: isFirstCall ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});
		return { session: created, contexts, started, release };
	}

	it("mid-turn displayOnly paints now, persists, and never reaches the provider or agent state", async () => {
		const harness = createStreamingSession(SessionManager.inMemory(tempDir.path()));
		session = harness.session;
		const painted: string[] = [];
		session.subscribe(event => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "custom") {
				painted.push(`${event.type}:${event.message.customType}:${event.message.excludeFromContext === true}`);
			}
		});

		const run = session.prompt("go");
		await harness.started.promise;
		expect(session.isStreaming).toBe(true);

		const dispatched = await session.sendCustomMessage(
			{ customType: REPORT_TYPE, content: REPORT_BODY, display: true, attribution: "agent" },
			{ deliverAs: "displayOnly", triggerTurn: true },
		);
		expect(dispatched).toBe(false);
		expect(painted).toEqual([`message_start:${REPORT_TYPE}:true`, `message_end:${REPORT_TYPE}:true`]);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		harness.release.resolve();
		await run;
		await session.waitForIdle();

		expect(harness.contexts).toHaveLength(2);
		expect(JSON.stringify(harness.contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(harness.contexts)).not.toContain(REPORT_BODY);
		expect(session.agent.state.messages.some(m => m.role === "custom" && m.customType === REPORT_TYPE)).toBe(false);

		const entries = session.sessionManager.getEntries();
		const persisted = entries.filter(e => e.type === "custom_message" && e.customType === REPORT_TYPE);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]!.type === "custom_message" && persisted[0]!.excludeFromContext).toBe(true);
		// Persisted at the moment it was sent: after the tool call, before the tool result.
		const index = (predicate: (entry: (typeof entries)[number]) => boolean) => entries.findIndex(predicate);
		const toolCallAt = index(e => e.type === "message" && e.message.role === "assistant");
		const reportAt = index(e => e.type === "custom_message" && e.customType === REPORT_TYPE);
		const toolResultAt = index(e => e.type === "message" && e.message.role === "toolResult");
		expect(toolCallAt).toBeLessThan(reportAt);
		expect(reportAt).toBeLessThan(toolResultAt);
	});

	it("idle displayOnly paints without a turn and stays out of the rebuilt model context after reload", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const harness = createStreamingSession(SessionManager.create(tempDir.path(), sessionDir));
		session = harness.session;
		const painted: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "custom") painted.push(event.message.customType);
		});
		// Session files are created lazily, after the first assistant message.
		harness.release.resolve();
		await session.prompt("go");
		await session.waitForIdle();
		expect(harness.contexts).toHaveLength(2);

		const dispatched = await session.sendCustomMessage(
			{ customType: REPORT_TYPE, content: REPORT_BODY, display: true, attribution: "agent" },
			{ deliverAs: "displayOnly", triggerTurn: true },
		);
		expect(dispatched).toBe(false);
		expect(session.isStreaming).toBe(false);
		expect(harness.contexts).toHaveLength(2);
		expect(painted).toEqual([REPORT_TYPE]);
		expect(session.agent.state.messages.some(m => m.role === "custom" && m.customType === REPORT_TYPE)).toBe(false);

		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();
		await session.dispose();
		session = undefined;

		const reopened = await SessionManager.open(sessionFile!, sessionDir);
		const transcript = reopened.buildSessionContext({ transcript: true }).messages;
		const report = transcript.find(m => m.role === "custom" && m.customType === REPORT_TYPE);
		expect(report).toBeDefined();
		expect(report!.role === "custom" && report!.excludeFromContext).toBe(true);
		expect(convertToLlm(transcript).some(m => JSON.stringify(m).includes(REPORT_BODY))).toBe(false);
		expect(
			reopened.buildSessionContext().messages.some(m => m.role === "custom" && m.customType === REPORT_TYPE),
		).toBe(false);
	});
});

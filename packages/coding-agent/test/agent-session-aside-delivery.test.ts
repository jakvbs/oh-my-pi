import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AssistantMessage, Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession aside delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aside-delivery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	it("an aside delivered mid-run neither aborts the in-flight tool nor waits for the run to end", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let abortedDuringTool = false;
		let abortSeen = false;

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				abortedDuringTool = signal?.aborted ?? false;
				signal?.addEventListener("abort", () => {
					abortSeen = true;
				});
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
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendCustomMessage(
			{ customType: "ext-aside", content: "ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);

		expect(abortSeen).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(abortedDuringTool).toBe(false);
		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("ASIDE_BODY");
		const asides = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(asides).toHaveLength(1);
	});

	it.each([false, true])(
		"a user aside ends an owned-job wait without consuming the later job result (agent registry: %s)",
		async withRegistry => {
			const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
			const contexts: Context[] = [];
			const nextCall = Promise.withResolvers<void>();
			const waitStarted = Promise.withResolvers<void>();
			const job = Promise.withResolvers<string>();
			const manager = new AsyncJobManager({});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"launch.enabled": false,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const wait = new WaitTool({
				cwd: tempDir.path(),
				settings,
				asyncJobManager: manager,
				getAgentId: () => "Main",
				...(withRegistry ? { agentRegistry: AgentRegistry.global() } : {}),
			} as ToolSession);
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [wait], messages: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					contexts.push(context);
					const first = contexts.length === 1;
					if (contexts.length === 2) nextCall.resolve();
					const message: AssistantMessage = {
						role: "assistant",
						content: first
							? [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }]
							: [{ type: "text", text: "Acknowledged." }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: first ? "toolUse" : "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
					});
					return stream;
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry: new ModelRegistry(authStorage),
				toolRegistry: new Map([[wait.name, wait as unknown as AgentTool]]),
				agentId: "Main",
				asyncJobManager: manager,
			});
			session.subscribe(event => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") waitStarted.resolve();
			});
			manager.register("bash", "pending", () => job.promise, { ownerId: "Main" });
			const run = session.prompt("go");
			try {
				await waitStarted.promise;
				await Bun.sleep(450);
				expect(contexts).toHaveLength(1);
				expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(1);
				await session.sendUserMessage("ASIDE_DURING_WAIT", { deliverAs: "aside" });
				const timer = setTimeout(() => nextCall.reject(new Error("Aside remained behind the pending wait")), 1_500);
				try {
					await nextCall.promise;
				} finally {
					clearTimeout(timer);
				}
				expect(JSON.stringify(contexts[1]?.messages)).toContain("ASIDE_DURING_WAIT");
				expect(JSON.stringify(contexts[1]?.messages)).toContain("Wait interrupted by message.");
				expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(1);
			} finally {
				job.resolve("JOB_RESULT_AFTER_ASIDE");
				await run;
				await session.settleAsyncWork();
			}
			expect(
				session.agent.state.messages.filter(
					message => message.role === "user" && JSON.stringify(message.content).includes("ASIDE_DURING_WAIT"),
				),
			).toHaveLength(1);
			expect(JSON.stringify(contexts.at(-1)?.messages)).toContain("JOB_RESULT_AFTER_ASIDE");
			expect(
				session.agent.state.messages.filter(message => JSON.stringify(message).includes("JOB_RESULT_AFTER_ASIDE")),
			).toHaveLength(1);
		},
	);

	it("sendUserMessage delivered as an aside mid-run injects at the next step boundary without draining agent-core queues", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
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
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendUserMessage("USER_ASIDE_BODY", { deliverAs: "aside" });

		// Not a steer/follow-up: neither agent-core queue drained the aside, so the tool batch
		// keeps running uninterrupted.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("USER_ASIDE_BODY");
		const userAsides = session.agent.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("USER_ASIDE_BODY"),
		);
		expect(userAsides).toHaveLength(1);
	});

	it("an idle session receiving an aside starts a turn", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const startedTurn = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "IDLE_ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		await session.waitForIdle();

		expect(startedTurn).toBe(true);
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).toContain("IDLE_ASIDE_BODY");
	});

	it("a stranded aside queued during an aborted turn does not leak into the target session (switchSession)", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				context => {
					contexts.push(context);
					return { content: ["target reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const targetManager = SessionManager.create(tempDir.path(), sessionDir);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const run = session.prompt("go");
		await started.promise;
		await session.sendUserMessage("LEAK_CANDIDATE_ASIDE", { deliverAs: "aside" });

		expect(await session.switchSession(targetFile)).toBe(true);
		await run.catch(() => {});
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => JSON.stringify(message).includes("LEAK_CANDIDATE_ASIDE")),
		).toBe(false);

		await session.prompt("ping");
		await session.waitForIdle();

		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).not.toContain("LEAK_CANDIDATE_ASIDE");
	});

	it("prompt()'s internal streaming re-check queues streamingBehavior 'aside' as a non-interrupting aside, not a steer", async () => {
		// Regression for the race sendUserMessage(..., { deliverAs: "aside" }) hands to prompt():
		// prompt() awaits manual-compaction cleanup / image normalization between its idle
		// observation and dispatch, so a turn can start streaming in that gap. Its internal
		// isStreaming re-check must honor the caller's original "aside" intent (via
		// `streamingBehavior: "aside"`) instead of degrading it into a tool-aborting steer.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let abortSeen = false;

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				signal?.addEventListener("abort", () => {
					abortSeen = true;
				});
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
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		// Simulates prompt()'s own internal isStreaming re-check landing while the tool is still
		// running — exactly what sendUserMessage's race threads through as streamingBehavior: "aside".
		await session.prompt("RACE_ASIDE_TEXT", {
			expandPromptTemplates: false,
			streamingBehavior: "aside",
		});

		expect(abortSeen).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("RACE_ASIDE_TEXT");
	});

	it("sendCustomMessage(deliverAs: 'aside') folds into context instead of starting a turn when a user interrupt outlasted normalization", async () => {
		// Regression: this branch is only reached once isStreaming reads false — which can happen
		// either because the session was already idle, or because image normalization above
		// outlasted a user Esc that settled the run in the meantime. The old code treated both
		// cases identically and always started a fresh autonomous turn, undoing a deliberate
		// interrupt. Simulate the second case directly: abort with a user interrupt (which sets
		// autoResumeSuppressed), then send the aside on the now-idle session.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, _signal) => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;
		release.resolve();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await session.waitForIdle();
		contexts.length = 0;

		const dispatched = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "SUPPRESSED_ASIDE", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);

		expect(dispatched).toBe(false);
		expect(contexts).toHaveLength(0);
		const persisted = session.agent.state.messages.some(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(persisted).toBe(true);
	});

	it("sendCustomMessage(deliverAs: 'aside'/'nextTurn') reports false when the agent-initiated turn never dispatches", async () => {
		// Regression: #promptAgentInitiatedMessage used to return void, so its callers hard-coded
		// `return true` unconditionally. If an abort races the usage-aware preflight (which
		// registers an AbortController and captures the prompt generation before its first real
		// await), the helper returns before ever calling agent.prompt — callers that treat the
		// boolean as proof of dispatched agent work (e.g. RPC's hasAgentMessageTask gate) must see
		// `false`, not a stale `true` that leaves them waiting on events that never arrive.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const dispatchedPromise = session.sendCustomMessage(
			{ customType: "ext-aside", content: "PREFLIGHT_RACE_ASIDE", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		// #beginInFlight() (which flips isStreaming) and the usage-aware preflight's abort
		// controller registration + generation capture run synchronously together with no
		// intervening await; poll until the first observable side effect (isStreaming) confirms
		// that stretch has run, then abort — landing inside the preflight's own first await,
		// exactly the race the fix covers.
		while (!session.isStreaming) {
			await Promise.resolve();
		}
		await session.abort({ reason: "internal" });

		expect(await dispatchedPromise).toBe(false);
		await session.waitForIdle();
		expect(contexts).toHaveLength(0);
	});

	it("drops a queued aside before a committed newSession() hook finishes", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const hookReached = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_switch", async () => {
					hookReached.resolve();
					await releaseHook.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"held-new-session-hook",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});

		const run = session.prompt("go");
		await started.promise;

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		let asideSettled = false;
		const asidePromise = session.sendUserMessage("GENERATION_RACE_ASIDE", { deliverAs: "aside" }).then(() => {
			asideSettled = true;
		});
		let newSessionPromise: Promise<boolean> | undefined;
		try {
			await normalizeStarted.promise;
			const previousId = session.sessionId;
			newSessionPromise = session.newSession();
			await hookReached.promise;
			expect(session.sessionId).not.toBe(previousId);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});

			// newSession never rolls its generation back. Let normalization and its
			// continuation drain, but keep the readiness hook explicitly held.
			releaseNormalize.resolve();
			await setImmediate();
			expect(asideSettled).toBe(true);
			expect(session.isSessionTransitioning).toBe(true);
			expect(ready).toBe(false);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("GENERATION_RACE_ASIDE");

			releaseHook.resolve();
			expect(await newSessionPromise).toBe(true);
			await waiting;
			await session.waitForIdle();
			expect(session.isSessionTransitioning).toBe(false);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("GENERATION_RACE_ASIDE");
		} finally {
			releaseNormalize.resolve();
			releaseHook.resolve();
			await newSessionPromise;
			await asidePromise;
			await run.catch(() => {});
			normalizeSpy.mockRestore();
		}
	});

	it("validates the session generation before an idle sendCustomMessage aside dispatch", async () => {
		// Regression: the streaming branch of sendCustomMessage's aside delivery checks
		// #sessionGeneration before enqueueing (#queueCustomMessage), but the idle branch
		// (post-interrupt fold / #promptAgentInitiatedMessage) never compared its own
		// captured generation. An image attachment whose normalization outlives a concurrent
		// newSession() used to prompt or fold the stale message into the newly created session.
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		try {
			expect(session.isStreaming).toBe(false);
			const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
			const dispatched = session.sendCustomMessage(
				{
					customType: "ext-aside",
					content: [{ type: "text", text: "IDLE_GENERATION_ASIDE" }, image],
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside" },
			);
			await normalizeStarted.promise;

			await session.newSession();
			releaseNormalize.resolve();

			expect(await dispatched).toBe(false);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("IDLE_GENERATION_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
		}
	});

	it("does not wake a stranded aside into an agent disconnected by an in-flight newSession()", async () => {
		// Regression: #disconnectFromAgent() runs at the very top of newSession(), well before
		// #sessionGeneration bumps (which happens only after agent.reset() and
		// sessionManager.newSession() complete). A user aside's normalization that resolves in
		// that gap sees an unchanged generation and a non-streaming agent, so
		// #resumeStrandedIrcAsides used to wake a fresh agent.prompt() on the disconnected agent,
		// racing the transition's own reset.
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		let callCount = 0;
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					callCount++;
					return { content: ["working"], delayMs: 60_000 };
				},
				() => {
					callCount++;
					return { content: ["woken reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const run = session.prompt("go");
		await started.promise;

		const advisorsGateReached = Promise.withResolvers<void>();
		const releaseAdvisorsGate = Promise.withResolvers<void>();
		const originalDrainAndDetachRecorders = SessionAdvisors.prototype.drainAndDetachRecorders;
		const advisorsSpy = spyOn(SessionAdvisors.prototype, "drainAndDetachRecorders").mockImplementation(
			async function (this: SessionAdvisors) {
				advisorsGateReached.resolve();
				await releaseAdvisorsGate.promise;
				return originalDrainAndDetachRecorders.call(this);
			},
		);
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});

		try {
			const asidePromise = session.sendUserMessage("DISCONNECTED_ASIDE", { deliverAs: "aside" });
			await normalizeStarted.promise;

			const newSessionPromise = session.newSession();
			// #disconnectFromAgent()/abort() have run; agent.reset() and the generation bump have not.
			await advisorsGateReached.promise;

			releaseNormalize.resolve();
			await asidePromise;
			// Flush any fire-and-forget microtask chain a stray #wakeForIrc call would have started
			// (agent.prompt() is invoked asynchronously, not synchronously, from #wakeForIrc).
			for (let i = 0; i < 5; i++) await Promise.resolve();

			expect(callCount).toBe(1);

			releaseAdvisorsGate.resolve();
			expect(await newSessionPromise).toBe(true);
			await run.catch(() => {});
			await session.waitForIdle();

			expect(JSON.stringify(session.agent.state.messages)).not.toContain("DISCONNECTED_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
			advisorsSpy.mockRestore();
		}
	});

	it("preserves a normalized aside across a rolled-back switchSession()", async () => {
		// Regression: the #sessionGeneration guard in #queueUserMessage's aside branch used to
		// discard a record outright on any generation mismatch. switchSession() bumps the
		// generation before its transition and only rolls it back to the exact prior value in its
		// catch block, so a record whose normalization resolved during that window was lost even
		// though the switch ultimately failed and the original session stayed live.
		const sessionDir = path.join(tempDir.path(), "sessions");
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				context => {
					contexts.push(context);
					return { content: ["woken reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const targetManager = SessionManager.create(tempDir.path(), sessionDir);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const run = session.prompt("go");
		await started.promise;

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const setSessionFileReached = Promise.withResolvers<void>();
		const releaseSetSessionFileFailure = Promise.withResolvers<void>();
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			setSessionFileReached.resolve();
			await releaseSetSessionFileFailure.promise;
			throw new Error("forced switchSession failure");
		});

		const rollbackReached = Promise.withResolvers<void>();
		const releaseRollback = Promise.withResolvers<void>();
		session.setSessionSwitchReconciler(async () => {
			rollbackReached.resolve();
			await releaseRollback.promise;
		});
		let asideSettled = false;
		const asidePromise = session.sendUserMessage("ROLLBACK_ASIDE", { deliverAs: "aside" }).then(() => {
			asideSettled = true;
		});
		let switchedPromise: Promise<boolean> | undefined;
		try {
			await normalizeStarted.promise;
			switchedPromise = session.switchSession(targetFile);
			// #sessionGeneration has bumped by now; setSessionFile is paused before it fails.
			await setSessionFileReached.promise;
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});

			releaseNormalize.resolve();
			await setImmediate();
			expect(asideSettled).toBe(false);
			releaseSetSessionFileFailure.resolve();
			await rollbackReached.promise;
			await setImmediate();
			// The restored generation belongs to the aside again, even while
			// Collab readiness still waits for rollback reconciliation.
			expect(asideSettled).toBe(true);
			expect(session.isSessionTransitioning).toBe(true);
			expect(ready).toBe(false);

			releaseRollback.resolve();
			await expect(switchedPromise).rejects.toThrow("forced switchSession failure");
			await waiting;
			await session.waitForIdle();
			expect(session.isSessionTransitioning).toBe(false);
			expect(contexts).toHaveLength(1);
			expect(JSON.stringify(contexts[0]!.messages)).toContain("ROLLBACK_ASIDE");
		} finally {
			releaseNormalize.resolve();
			releaseSetSessionFileFailure.resolve();
			releaseRollback.resolve();
			await switchedPromise?.catch(() => {});
			await asidePromise;
			await run.catch(() => {});
			normalizeSpy.mockRestore();
			setSessionFileSpy.mockRestore();
		}
	});
});

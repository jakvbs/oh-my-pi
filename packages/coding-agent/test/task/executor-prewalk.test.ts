/**
 * Per-agent prewalk resolution in `runSubprocess`: the `task.agentPrewalk`
 * setting decides whether the spawned session gets a `prewalk` hand-off config,
 * which target model it resolves to, and when the hand-off is skipped (target
 * identical to the starting model).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgTaskAgentPrewalk } from "@oh-my-pi/pi-coding-agent/task/settings";

function yieldEmittingSession(
	initialTools: string[] = ["read", "yield"],
	modelSwitch?: { from: Model; to: Model },
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let activeTools = initialTools;
	// `servingModel` mirrors the real session: attribution names the model that
	// produced output, so a prewalk hand-off moves it along with `model`.
	const serving = (model: Model | undefined): { selector: string; isFallback: boolean } | undefined =>
		model ? { selector: `${model.provider}/${model.id}`, isFallback: false } : undefined;
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: modelSwitch?.from,
		servingModel: serving(modelSwitch?.from),
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => activeTools,
		getEnabledToolNames: () => activeTools,
		getAllToolNames: () => activeTools,
		setActiveToolsByName: async (toolNames: string[]) => {
			activeTools = toolNames;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			if (modelSwitch) {
				session.model = modelSwitch.to;
				session.servingModel = serving(modelSwitch.to);
				for (const listener of listeners) {
					listener({ type: "notice", level: "info", message: "Prewalk switched", source: "prewalk" });
				}
			}
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-prewalk",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function modelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model ${id}`);
	return model;
}

function createModelRegistry(models: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess per-agent prewalk", () => {
	const primary = modelOrThrow("claude-sonnet-4-5");
	const target = modelOrThrow("claude-sonnet-4-6");

	function baseOptions(id: string, settings: Settings) {
		return {
			cwd: "/tmp",
			task: "do work",
			index: 0,
			id,
			settings,
			modelRegistry: createModelRegistry([primary, target]),
			enableLsp: false,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a configured prewalk pattern to a target for the spawned session", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions(
				"subagent-prewalk-frontmatter",
				Settings.isolated({ "task.agentPrewalk": { task: `${target.provider}/${target.id}` } }),
			),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
			},
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
		expect(forwarded?.prewalk?.target.provider).toBe(target.provider);
	});

	it("waits for background discovery before resolving a configured prewalk target", async () => {
		const models = [primary];
		const registry = createModelRegistry(models);
		const refreshGate = Promise.withResolvers<void>();
		vi.spyOn(registry, "awaitBackgroundRefresh").mockImplementation(async () => {
			await refreshGate.promise;
			models.push(target);
		});
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const run = runSubprocess({
			...baseOptions(
				"subagent-prewalk-discovery",
				Settings.isolated({ "task.agentPrewalk": { task: `${target.provider}/${target.id}` } }),
			),
			modelRegistry: registry,
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
			},
		});
		expect(spy).not.toHaveBeenCalled();

		refreshGate.resolve();
		expect((await run).exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("reports the prewalk target as the active model after handoff", async () => {
		const progressModels: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(yieldEmittingSession(["read", "yield"], { from: primary, to: target })),
		);

		const result = await runSubprocess({
			...baseOptions(
				"subagent-prewalk-progress-model",
				Settings.isolated({ "task.agentPrewalk": { task: `${target.provider}/${target.id}` } }),
			),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
			},
			onProgress: progress => {
				if (progress.resolvedModel) progressModels.push(progress.resolvedModel);
			},
		});

		expect(result.exitCode).toBe(0);
		expect(progressModels.at(-1)).toBe(`${target.provider}/${target.id}`);
	});

	it("resolves prewalk 'on' through the smol role default target", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		cfgTaskAgentPrewalk.set(settings, { task: "on" });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-default-target", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
	});

	it("skips prewalk when the target resolves to the starting model", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions(
				"subagent-prewalk-same-model",
				Settings.isolated({ "task.agentPrewalk": { task: `${primary.provider}/${primary.id}` } }),
			),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
	});
	it("keeps the todo tool active for a prewalk-armed subagent (the todo gate needs it)", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions(
				"subagent-prewalk-todo-kept",
				Settings.isolated({ "task.agentPrewalk": { task: `${target.provider}/${target.id}` } }),
			),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
			},
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).toContain("todo");
	});

	it("strips the parent-owned todo tool from non-prewalk subagents", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions("subagent-no-prewalk-todo-stripped", Settings.isolated()),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).not.toContain("todo");
		expect(session.getActiveToolNames()).toContain("read");
	});
});

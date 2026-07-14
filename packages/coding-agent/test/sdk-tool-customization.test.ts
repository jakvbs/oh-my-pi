import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

interface ProbeDetails {
	invocations: number;
}

const probeParameters = Type.Object({ value: Type.Number() });
type ProbeParameters = Static<typeof probeParameters>;

class StatefulProbe {
	readonly label: string;
	readonly description = "original probe description";
	readonly parameters = probeParameters;
	readonly approval = "read" as const;
	readonly name: string;
	#invocations = 0;
	observedToolCallId: string | undefined;
	observedParams: ProbeParameters | undefined;
	observedSignal: AbortSignal | undefined;
	observedUpdate: AgentToolUpdateCallback<ProbeDetails> | undefined;

	constructor(name = "stateful_probe") {
		this.name = name;
		this.label = name === "stateful_probe" ? "Stateful Probe" : "Replacement Read";
	}

	get invocations(): number {
		return this.#invocations;
	}

	async execute(
		toolCallId: string,
		params: ProbeParameters,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<ProbeDetails> | undefined,
		_ctx: ExtensionContext,
	): Promise<AgentToolResult<ProbeDetails>> {
		if (typeof params !== "object" || params === null || !("value" in params) || typeof params.value !== "number") {
			throw new Error("Expected numeric probe value");
		}
		this.#invocations += 1;
		this.observedToolCallId = toolCallId;
		this.observedParams = params;
		this.observedSignal = signal;
		this.observedUpdate = onUpdate;
		return {
			content: [{ type: "text", text: `probe:${params.value}` }],
			details: { invocations: this.#invocations },
		};
	}
}

describe("Extension tool customization", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-tool-customization-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const createSession = async (extensions: ExtensionFactory[]) => {
		return await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
	};

	it("patches a built-in description in the provider-visible session catalog", async () => {
		const customizeRead: ExtensionFactory = pi => {
			pi.patchTool("read", { description: "project read policy" });
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(read?.description).toBe("project read policy");
			expect(session.agent.state.tools.filter(tool => tool.name === "read")).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	it("preserves the exact live execution call contract", async () => {
		const probe = new StatefulProbe();
		const patchProbe: ExtensionFactory = pi => {
			pi.registerTool(probe);
			pi.patchTool("stateful_probe", { description: "patched probe" });
		};
		const { session } = await createSession([patchProbe]);
		const signal = new AbortController().signal;
		const update: AgentToolUpdateCallback<ProbeDetails> = () => {};
		const params = { value: 7 };

		try {
			const tool = session.agent.state.tools.find(candidate => candidate.name === "stateful_probe");
			expect(tool?.description).toBe("patched probe");
			const result = await tool?.execute("call-17", params, signal, update);

			expect(probe.invocations).toBe(1);
			expect(probe.observedToolCallId).toBe("call-17");
			expect(probe.observedParams).toBe(params);
			expect(probe.observedSignal).toBe(signal);
			expect(probe.observedUpdate).toBe(update);
			expect(result).toEqual({
				content: [{ type: "text", text: "probe:7" }],
				details: { invocations: 1 },
			});
		} finally {
			await session.dispose();
		}
	});

	it("patches a label without changing other metadata or execution", async () => {
		const probe = new StatefulProbe();
		const patchProbe: ExtensionFactory = pi => {
			pi.registerTool(probe);
			pi.patchTool("stateful_probe", { label: "Project Probe" });
		};
		const { session } = await createSession([patchProbe]);

		try {
			const tool = session.agent.state.tools.find(candidate => candidate.name === "stateful_probe");
			expect(tool?.label).toBe("Project Probe");
			expect(tool?.description).toBe("original probe description");
			await tool?.execute("call-label", { value: 1 });
			expect(probe.invocations).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("accepts an empty metadata patch as a no-op", async () => {
		const customizeRead: ExtensionFactory = pi => {
			pi.patchTool("read", {});
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(read?.label).toBe("Read");
			expect(read?.description).toContain("Read files, directories");
			expect(session.agent.state.tools.filter(tool => tool.name === "read")).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	it("wraps bound class execution inside lifecycle interception", async () => {
		const probe = new StatefulProbe();
		const events: string[] = [];
		const wrapProbe: ExtensionFactory = pi => {
			pi.registerTool(probe);
			pi.on("tool_call", () => {
				events.push("tool_call");
			});
			pi.on("tool_result", () => {
				events.push("tool_result");
			});
			pi.wrapTool("stateful_probe", original => ({
				async execute(toolCallId, params, signal, onUpdate, context) {
					events.push("decorated_execute");
					return await original.execute(toolCallId, params, signal, onUpdate, context);
				},
			}));
		};
		const { session } = await createSession([wrapProbe]);

		try {
			const tool = session.agent.state.tools.find(candidate => candidate.name === "stateful_probe");
			const result = await tool?.execute("call-private-state", { value: 42 });
			expect(probe.invocations).toBe(1);
			expect(result?.content).toEqual([{ type: "text", text: "probe:42" }]);
			expect(events).toEqual(["tool_call", "decorated_execute", "tool_result"]);
		} finally {
			await session.dispose();
		}
	});

	it("overrides supported decorator fields and retains omitted fields", async () => {
		const replacementParameters = Type.Object({ replacement: Type.String() });
		const replacementRenderCall = () => null as never;
		let originalLabel = "";
		let originalRenderResult: unknown;
		const customizeRead: ExtensionFactory = pi => {
			pi.wrapTool("read", original => {
				originalLabel = original.label;
				originalRenderResult = original.renderResult;
				return {
					description: "new description",
					parameters: replacementParameters,
					strict: true,
					approval: "exec",
					renderCall: replacementRenderCall,
				};
			});
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(read).toMatchObject({
				name: "read",
				label: originalLabel,
				description: "new description",
				parameters: replacementParameters,
				strict: true,
				approval: "exec",
				renderCall: replacementRenderCall,
			});
			expect(read?.renderResult === originalRenderResult).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("composes customizations in registration order", async () => {
		let observedDescription = "";
		const customizeRead: ExtensionFactory = pi => {
			pi.patchTool("read", { description: "first" });
			pi.wrapTool("read", original => {
				observedDescription = original.description;
				return { description: `${original.description}+second` };
			});
			pi.patchTool("read", { label: "Project Read" });
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(observedDescription).toBe("first");
			expect(read?.description).toBe("first+second");
			expect(read?.label).toBe("Project Read");
		} finally {
			await session.dispose();
		}
	});

	it("customizes the final same-name registered winner", async () => {
		const replacement = new StatefulProbe("read");
		const replaceAndCustomizeRead: ExtensionFactory = pi => {
			pi.registerTool(replacement);
			pi.patchTool("read", { description: "customized replacement" });
		};
		const { session } = await createSession([replaceAndCustomizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			const result = await read?.execute("call-replacement", { value: 9 });
			expect(read?.description).toBe("customized replacement");
			expect(result?.content).toEqual([{ type: "text", text: "probe:9" }]);
			expect(replacement.invocations).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("applies wrappers once to each fresh session registry", async () => {
		const wrapperCalls: number[] = [];
		const probes: StatefulProbe[] = [];
		const registerWrappedProbe: ExtensionFactory = pi => {
			const index = wrapperCalls.push(0) - 1;
			const probe = new StatefulProbe();
			probes.push(probe);
			pi.registerTool(probe);
			pi.wrapTool("stateful_probe", original => ({
				description: `${original.description}+wrapped`,
				async execute(toolCallId, params, signal, onUpdate, context) {
					wrapperCalls[index] += 1;
					return await original.execute(toolCallId, params, signal, onUpdate, context);
				},
			}));
		};
		const first = await createSession([registerWrappedProbe]);
		const firstTool = first.session.agent.state.tools.find(tool => tool.name === "stateful_probe");
		await firstTool?.execute("call-first", { value: 1 });
		await first.session.dispose();

		const second = await createSession([registerWrappedProbe]);
		try {
			const secondTool = second.session.agent.state.tools.find(tool => tool.name === "stateful_probe");
			await secondTool?.execute("call-second", { value: 2 });
			expect(firstTool?.description).toBe("original probe description+wrapped");
			expect(secondTool?.description).toBe("original probe description+wrapped");
			expect(wrapperCalls).toEqual([1, 1]);
			expect(probes.map(probe => probe.invocations)).toEqual([1, 1]);
		} finally {
			await second.session.dispose();
		}
	});

	it("warns and skips a missing target", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const customizeMissing: ExtensionFactory = pi => {
			pi.patchTool("missing_tool", { description: "unused" });
		};
		const { session } = await createSession([customizeMissing]);

		try {
			expect(session.agent.state.tools.some(tool => tool.name === "missing_tool")).toBe(false);
			expect(warn).toHaveBeenCalledWith(
				"Extension tool customization target not found",
				expect.objectContaining({ extensionPath: expect.any(String), target: "missing_tool" }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("isolates a thrown decorator and continues with later customizations", async () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const customizeRead: ExtensionFactory = pi => {
			pi.wrapTool("read", () => {
				throw new Error("boom");
			});
			pi.patchTool("read", { description: "recovered" });
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(read?.description).toBe("recovered");
			expect(error).toHaveBeenCalledWith(
				"Extension tool customization failed",
				expect.objectContaining({ extensionPath: expect.any(String), target: "read", error: "boom" }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("isolates invalid decorator results and attempted renames", async () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const customizeRead: ExtensionFactory = pi => {
			pi.wrapTool("read", () => null as never);
			pi.wrapTool("read", () => ({ name: "project_read", description: "renamed" }) as never);
		};
		const { session } = await createSession([customizeRead]);

		try {
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			expect(read?.description).toContain("Read files, directories");
			expect(session.agent.state.tools.some(tool => tool.name === "project_read")).toBe(false);
			expect(error).toHaveBeenCalledTimes(2);
			expect(error.mock.calls.map(([, details]) => details)).toEqual([
				expect.objectContaining({ target: "read", error: "Tool decorator must return a partial override object" }),
				expect.objectContaining({ target: "read", error: "Tool decorators cannot change a tool name" }),
			]);
		} finally {
			await session.dispose();
		}
	});
});

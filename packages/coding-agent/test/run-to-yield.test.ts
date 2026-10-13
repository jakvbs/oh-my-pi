import { describe, expect, it } from "bun:test";
import {
	type AgentSession,
	type AgentSessionEvent,
	PromptDroppedError,
	type PromptOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSessionToYield } from "@oh-my-pi/pi-coding-agent/session/run-to-yield";
import { createSessionDefaults } from "./helpers/session-defaults";

/**
 * Contracts under test: how the embedder-facing driver sends the task, reminds the model to `yield`,
 * waits for background jobs and classifies the end of the session. A scripted session stands in for the
 * model; `test/run-session-to-yield.test.ts` covers the same driver against a real session.
 */

const outputSchema = {
	type: "object",
	properties: { report: { type: "string" } },
	required: ["report"],
	additionalProperties: false,
};
const strictOptions = { outputSchema, outputSchemaMode: "strict" } as const;

interface ScriptedSession {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	/** Owner background work the driver's barrier sees; `settleAsyncWork` clears it. */
	asyncPending: { value: boolean };
	/** Runs when the barrier settles background work, before it reports idle. */
	onSettle: { current: (emit: (event: AgentSessionEvent) => void) => void };
}

function createScriptedSession(
	onPrompt: (turn: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => "dropped" | void,
): ScriptedSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let promptIndex = 0;
	const asyncPending = { value: false };
	const onSettle: ScriptedSession["onSettle"] = { current: () => {} };
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may unsubscribe during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		model: { api: "anthropic-messages" } as never,
		subscribe: listener => {
			listeners.push(listener);
			return () => {
				listeners.splice(listeners.indexOf(listener), 1);
			};
		},
		prompt: async (text, options) => {
			promptIndex += 1;
			prompts.push({ text, options });
			const outcome = onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			if (outcome === "dropped" && options?.throwOnDrop) throw new PromptDroppedError();
			return true;
		},
		getLastAssistantMessage: () => messages.at(-1) as never,
		hasPendingAsyncWork: () => asyncPending.value,
		settleAsyncWork: async () => {
			asyncPending.value = false;
			onSettle.current(emit);
		},
		abort: async () => {
			abortCount += 1;
		},
	};
	return { session: session as AgentSession, prompts, abortCalls: () => abortCount, asyncPending, onSettle };
}

function assistantTurn(
	turn: { emit: (event: AgentSessionEvent) => void; pushMessage: (message: unknown) => void },
	content: unknown[],
	stopReason: string,
	extra: Record<string, unknown> = {},
) {
	const message = { role: "assistant", content, stopReason, ...extra };
	turn.pushMessage(message);
	turn.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
}

const textTurn = (turn: Parameters<typeof assistantTurn>[0], text: string) =>
	assistantTurn(turn, [{ type: "text", text }], "stop");

function yieldTurn(
	turn: Parameters<typeof assistantTurn>[0],
	details: Record<string, unknown>,
	isError = false,
	callId = "yield-call",
) {
	assistantTurn(turn, [{ type: "toolCall", id: callId, name: "yield", arguments: {} }], "toolUse");
	turn.emit({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "yield",
		result: { content: [{ type: "text", text: "Result submitted." }], details },
		isError,
	} as unknown as AgentSessionEvent);
}

const reportYield = (report: string) => ({ status: "success", data: { report } });

describe("runSessionToYield prompt dispatch", () => {
	it("resends an assignment dropped before dispatch and delivers the yield from the fourth attempt", async () => {
		const handle = createScriptedSession(turn => {
			if (turn.promptIndex < 4) return "dropped";
			yieldTurn(turn, reportYield("RECOVERED"));
		});
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({ kind: "yielded", data: { report: "RECOVERED" } });
		expect(handle.prompts.map(({ text }) => text)).toEqual(Array(4).fill("Inventory."));
	});

	it("fails without reminding when every attempt to send the assignment is dropped", async () => {
		const handle = createScriptedSession(() => "dropped");
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({
			kind: "no-yield",
			message: "initial prompt dropped before provider dispatch after 4 attempts",
		});
		expect(handle.prompts).toHaveLength(4);
	});
});

describe("runSessionToYield reminders", () => {
	it("pins only the last reminder to the yield tool, then reports the missing yield", async () => {
		const handle = createScriptedSession(turn => textTurn(turn, `Still thinking ${turn.promptIndex}`));
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome.kind).toBe("no-yield");
		expect(handle.prompts).toHaveLength(4);
		expect(handle.prompts.slice(1, 3).map(({ options }) => options?.toolChoice)).toEqual([undefined, undefined]);
		expect(handle.prompts[3]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
	});

	it("stops the free-running turn once the yield is accepted", async () => {
		const handle = createScriptedSession(turn => yieldTurn(turn, reportYield("DONE")));
		await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(handle.abortCalls()).toBe(1);
		expect(handle.prompts).toHaveLength(1);
	});
});

describe("runSessionToYield background jobs", () => {
	it("demands a fresh yield when job results delivered after the yield supersede it", async () => {
		const handle = createScriptedSession(turn => {
			if (turn.promptIndex === 1) {
				handle.asyncPending.value = true;
				yieldTurn(turn, reportYield("STALE"));
				return;
			}
			yieldTurn(turn, reportYield("FRESH"));
		});
		handle.onSettle.current = emit =>
			emit({
				type: "message_start",
				message: { role: "custom", customType: "async-result", content: "job finished" },
			} as unknown as AgentSessionEvent);
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({ kind: "yielded", data: { report: "FRESH" } });
		expect(handle.prompts).toHaveLength(2);
	});

	it("does not remind while the model's turn is parked on background work", async () => {
		const handle = createScriptedSession(turn => {
			if (turn.promptIndex === 1) {
				handle.asyncPending.value = true;
				textTurn(turn, "Waiting for the job.");
				return;
			}
			yieldTurn(turn, reportYield("AFTER-JOB"));
		});
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({ kind: "yielded", data: { report: "AFTER-JOB" } });
		expect(handle.prompts).toHaveLength(2);
	});
});

describe("runSessionToYield outcomes", () => {
	it("rejects a yield that misses the schema in strict mode", async () => {
		const handle = createScriptedSession(turn => yieldTurn(turn, { status: "success", data: { other: 1 } }));
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({
			kind: "schema-violation",
			message: "schema_violation: missing required fields: report",
		});
	});

	it("rejects data accepted past the tool's schema-retry budget", async () => {
		const handle = createScriptedSession(turn =>
			yieldTurn(turn, { status: "success", data: { report: "ok" }, schemaOverridden: true }),
		);
		const outcome = await runSessionToYield(handle.session, "Inventory.", { outputSchema });
		expect(outcome.kind).toBe("schema-violation");
	});

	it("reports the reason of a yield that submitted an error", async () => {
		const handle = createScriptedSession(turn =>
			yieldTurn(turn, { status: "aborted", error: "repository is read-only" }),
		);
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({ kind: "aborted", message: "repository is read-only" });
	});

	it("gives up after repeated invalid yields instead of looping", async () => {
		const handle = createScriptedSession(turn => {
			for (let call = 0; call < 6; call++) yieldTurn(turn, {}, true, `bad-${call}`);
		});
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome.kind).toBe("no-yield");
		expect(outcome.kind !== "yielded" && outcome.message).toContain("invalid yield results 6 times");
		expect(handle.prompts).toHaveLength(1);
	});

	it("reports the caller's abort reason when no yield landed", async () => {
		const controller = new AbortController();
		const handle = createScriptedSession(() => controller.abort(new Error("deadline passed")));
		const outcome = await runSessionToYield(handle.session, "Inventory.", {
			...strictOptions,
			signal: controller.signal,
		});
		expect(outcome).toEqual({ kind: "aborted", message: "deadline passed" });
		expect(handle.abortCalls()).toBeGreaterThan(0);
	});

	it("attributes a provider error to the failing model and sends no further reminders", async () => {
		const handle = createScriptedSession(turn => {
			if (turn.promptIndex === 1) return textTurn(turn, "Done.");
			assistantTurn(turn, [], "error", { errorMessage: "529 overloaded", provider: "anthropic", model: "opus" });
		});
		const outcome = await runSessionToYield(handle.session, "Inventory.", strictOptions);
		expect(outcome).toEqual({ kind: "provider-error", message: "[anthropic/opus] 529 overloaded" });
		expect(handle.prompts).toHaveLength(2);
	});
});

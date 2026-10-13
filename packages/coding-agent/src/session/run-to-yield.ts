import { EventLoopKeepalive } from "@oh-my-pi/pi-agent-core";
import type { YieldItem } from "@oh-my-pi/pi-tui/tools/yield";
import { isRecord, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import yieldReminderTemplate from "../prompts/system/yield-reminder.md" with { type: "text" };
import {
	buildOutputValidator,
	type OutputSchemaMode,
	summarizeValidationFailure,
} from "../tools/output-schema-validator";
import { buildNamedToolChoice } from "../utils/tool-choice";
import { type AgentSession, type AgentSessionEvent, PromptDroppedError, type PromptOptions } from "./agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-job-delivery";

/** How {@link runSessionToYield} ended: the yielded data that passed the output schema, or why there is none. */
export type SessionYieldOutcome =
	| { kind: "yielded"; data: unknown }
	| { kind: "provider-error" | "aborted" | "no-yield" | "schema-violation"; message: string };

export interface RunSessionToYieldOptions {
	/** The schema and mode the session was created with; the yield is validated against them once more. */
	outputSchema: unknown;
	outputSchemaMode?: OutputSchemaMode;
	signal?: AbortSignal;
}

const MAX_YIELD_REMINDERS = 3;
const MAX_YIELD_TOOL_ERRORS = 6;
const MAX_PROMPT_DISPATCH_ATTEMPTS = 4;
const PROMPT_DISPATCH_IDLE_TIMEOUT_MS = 5_000;
const TURN_STOP_SETTLE_TIMEOUT_MS = 5_000;

const MISSING_YIELD_MESSAGE = "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";
const NULL_YIELD_MESSAGE = "SYSTEM WARNING: Subagent called yield with null data.";
const SCHEMA_OVERRIDDEN_MESSAGE =
	"SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
const ABORTED_YIELD_MESSAGE = "Subagent aborted task";
const STALE_YIELD_MESSAGE =
	"Background job results arrived after the last yield; no refreshed yield covering them was submitted.";

class PromptDispatchError extends Error {}

function readYieldItem(details: unknown): YieldItem | undefined {
	if (!isRecord(details)) return undefined;
	const { status } = details;
	if (status !== "success" && status !== "aborted") return undefined;
	const type = details.type;
	return {
		data: details.data,
		status,
		error: typeof details.error === "string" ? details.error : undefined,
		type:
			typeof type === "string" || (Array.isArray(type) && type.every(label => typeof label === "string"))
				? type
				: undefined,
		complete: details.complete === true ? true : undefined,
		schemaOverridden: details.schemaOverridden === true ? true : undefined,
	};
}

function attributeProviderError(message: string | undefined, provider: string | undefined, model: string | undefined) {
	const text = message?.trim() ? message : "Subagent failed";
	const identity = provider && model ? `${provider}/${model}` : (provider ?? model);
	if (!identity || (provider && text.toLowerCase().includes(provider.toLowerCase()))) return text;
	return `[${identity}] ${text}`;
}

/** Validate an accepted yield once more against the caller's schema and mode. */
function resolveYieldedData(item: YieldItem, options: RunSessionToYieldOptions): SessionYieldOutcome {
	if (item.data === undefined || item.data === null) return { kind: "schema-violation", message: NULL_YIELD_MESSAGE };
	if (item.schemaOverridden) return { kind: "schema-violation", message: SCHEMA_OVERRIDDEN_MESSAGE };
	const { validator, error } = buildOutputValidator(options.outputSchema);
	if (error) return { kind: "schema-violation", message: `schema_violation: invalid output schema: ${error}` };
	const data = options.outputSchemaMode === "strict" ? (validator?.normalize(item.data) ?? item.data) : item.data;
	const validation = validator?.validate(data);
	if (validation && !validation.success) {
		const failure = summarizeValidationFailure(validation, data, validator?.requiredFields ?? []);
		const message =
			failure.missingRequired.length > 0
				? `schema_violation: missing required fields: ${failure.missingRequired.join(", ")}`
				: `schema_violation: ${failure.message}`;
		return { kind: "schema-violation", message };
	}
	return { kind: "yielded", data };
}

function resolveSignalAbortMessage(signal: AbortSignal | undefined): string {
	const reason = signal?.reason;
	const message = reason instanceof Error ? reason.message.trim() : typeof reason === "string" ? reason.trim() : "";
	return message || "Cancelled by caller";
}

/**
 * Drive a session created with `requireYieldTool` until it submits its structured result: send the task,
 * remind the model to `yield` when a turn ends without a tool call (the last reminder forces the `yield`
 * tool choice), wait for owned background jobs to settle, and classify how the session ended. For SDK
 * embedders that own the session and need its structured result.
 */
export async function runSessionToYield(
	session: AgentSession,
	task: string,
	options: RunSessionToYieldOptions,
): Promise<SessionYieldOutcome> {
	using _keepalive = new EventLoopKeepalive();
	const { signal } = options;
	let accepted: YieldItem | undefined;
	let invalidatedByAsync = false;
	let forceFinalYield = false;
	let consecutiveYieldErrors = 0;
	let failure: string | undefined;
	let turnStop: Promise<unknown> = Promise.resolve();

	// Stops the free-running turn without ending the run: the loop below then settles owned
	// background jobs, or finishes, depending on what the session still has pending.
	const stopTurn = () => {
		turnStop = Promise.all([
			turnStop,
			session.abort().catch(error => {
				logger.debug("Session abort after yield failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}),
		]);
	};

	const onEvent = (event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			// An async-result follow-up postdating the yield supersedes it: the payload predates job outcomes the model now sees.
			const message = event.message;
			if (
				accepted &&
				!signal?.aborted &&
				message?.role === "custom" &&
				message.customType === ASYNC_RESULT_MESSAGE_TYPE
			) {
				accepted = undefined;
				invalidatedByAsync = true;
			}
			return;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== "yield") return;
		if (event.isError) {
			consecutiveYieldErrors++;
			if (consecutiveYieldErrors >= MAX_YIELD_TOOL_ERRORS && !signal?.aborted) {
				failure = `Session submitted invalid yield results ${consecutiveYieldErrors} times; stopping to avoid an infinite submit loop.`;
				stopTurn();
			}
			return;
		}
		consecutiveYieldErrors = 0;
		const item = readYieldItem(event.result?.details);
		if (!item) return;
		const incremental = Array.isArray(item.type) && item.type.length > 0;
		if (incremental && !forceFinalYield && !item.complete && item.status !== "aborted") return;
		accepted = item;
		invalidatedByAsync = false;
		stopTurn();
	};

	const onSignalAbort = () => stopTurn();
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	const unsubscribe = session.subscribe(onEvent);

	const idleDeadline = () => AbortSignal.timeout(PROMPT_DISPATCH_IDLE_TIMEOUT_MS);
	// Retries pre-provider drops; local slash commands stay off so the text always reaches the model.
	const dispatchPrompt = async (text: string, promptOptions: PromptOptions, label: string): Promise<void> => {
		for (let attempt = 1; attempt <= MAX_PROMPT_DISPATCH_ATTEMPTS; attempt++) {
			try {
				await session.prompt(text, { ...promptOptions, runCommands: false, throwOnDrop: true });
				return;
			} catch (error) {
				if (!(error instanceof PromptDroppedError)) throw error;
			}
			if (attempt === MAX_PROMPT_DISPATCH_ATTEMPTS) {
				throw new PromptDispatchError(`${label} dropped before provider dispatch after ${attempt} attempts`);
			}
			const deadline = idleDeadline();
			try {
				await untilAborted(signal ? AbortSignal.any([signal, deadline]) : deadline, () => session.waitForIdle());
			} catch (error) {
				if (signal?.aborted) return;
				if (deadline.aborted) {
					throw new PromptDispatchError(`${label} dropped before provider dispatch; session did not become idle`);
				}
				throw error;
			}
			await Bun.sleep(250 * 2 ** (attempt - 1));
			if (signal?.aborted) return;
		}
	};

	const lastTurnFailed = () => session.getLastAssistantMessage()?.stopReason === "error";
	const runReminderLadder = async () => {
		for (let reminder = 1; !accepted && !failure && reminder <= MAX_YIELD_REMINDERS && !signal?.aborted; reminder++) {
			// A terminal provider error repeats on every retry; a turn parked on owner work is a scheduling pause.
			if (lastTurnFailed() || session.hasPendingAsyncWork()) return;
			// The last reminder pins the model to `yield`, so an incremental section cannot satisfy the pin forever.
			const isFinal = reminder === MAX_YIELD_REMINDERS;
			const toolChoice = isFinal ? buildNamedToolChoice("yield", session.model) : undefined;
			forceFinalYield = isFinal;
			try {
				await dispatchPrompt(
					prompt.render(yieldReminderTemplate, { retryCount: reminder, maxRetries: MAX_YIELD_REMINDERS }),
					{ attribution: "agent", synthetic: true, ...(toolChoice ? { toolChoice } : {}) },
					"yield reminder",
				);
				await session.waitForIdle();
			} catch (error) {
				if (error instanceof PromptDispatchError) throw error;
				logger.error("Yield reminder failed", { error: error instanceof Error ? error.message : String(error) });
			} finally {
				forceFinalYield = false;
			}
		}
	};

	try {
		try {
			await dispatchPrompt(task, { attribution: "agent" }, "initial prompt");
			await session.waitForIdle();
		} catch (error) {
			// Stopping the turn after an accepted yield can surface here as a rejected prompt.
			if (!accepted && !failure && !signal?.aborted) throw error;
		}

		// A yield with owned background jobs still pending is a scheduling pause: settle the jobs,
		// whose delivered results supersede the yield and demand a fresh one from the ladder.
		while (!signal?.aborted && !failure) {
			if (!accepted) {
				await runReminderLadder();
				if (!accepted && (lastTurnFailed() || !session.hasPendingAsyncWork())) break;
			}
			await turnStop;
			if (!session.hasPendingAsyncWork()) {
				if (accepted) break;
				continue;
			}
			await session.settleAsyncWork();
		}
	} catch (error) {
		if (!signal?.aborted) failure ??= error instanceof Error ? error.message : String(error);
	} finally {
		try {
			await untilAborted(AbortSignal.timeout(TURN_STOP_SETTLE_TIMEOUT_MS), () => turnStop);
		} catch {
			// The session stays usable for disposal either way.
		}
		unsubscribe();
		signal?.removeEventListener("abort", onSignalAbort);
	}

	if (accepted) {
		if (accepted.status === "aborted") return { kind: "aborted", message: accepted.error || ABORTED_YIELD_MESSAGE };
		return resolveYieldedData(accepted, options);
	}
	if (signal?.aborted) return { kind: "aborted", message: resolveSignalAbortMessage(signal) };
	const last = session.getLastAssistantMessage();
	if (last?.stopReason === "error") {
		return {
			kind: "provider-error",
			message: attributeProviderError(last.errorMessage, last.provider, last.model),
		};
	}
	if (failure) return { kind: "no-yield", message: failure };
	return { kind: "no-yield", message: invalidatedByAsync ? STALE_YIELD_MESSAGE : MISSING_YIELD_MESSAGE };
}

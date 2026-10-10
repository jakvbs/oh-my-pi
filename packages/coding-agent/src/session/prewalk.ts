import type { Agent, AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import { type ConfiguredThinkingLevel, prewalkWouldBeNoop } from "@oh-my-pi/pi-tui/thinking";
import type { Prewalk } from "./agent-session-types";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/** Hidden plan steering is consumed within the live run and must not reappear after a context rebuild. */
export function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

/**
 * Whether a completed tool result is the first workspace-mutating action that
 * arms the prewalk hand-off. A direct `edit`/`write` call always counts; a
 * `write` that dispatched an `xd://` device (e.g. `lsp`) counts only when the
 * wrapped tool resolved to a `write`/`exec` approval tier. Read-only device
 * calls — LSP navigation, help lookups — leave the tier `read` (or absent) and must not
 * switch the model mid-investigation (issue #7312).
 */
function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	// A direct filesystem edit/write carries no `xd://` dispatch metadata.
	if (!details || typeof details !== "object" || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	// Device dispatch: switch only on a genuine mutation tier. An absent tier
	// (help lookup, unresolved approval) declines the switch, matching the
	// reporter's "stay on the large model a couple turns longer" preference.
	if (typeof xdev !== "object" || !("tier" in xdev)) return false;
	return xdev.tier === "write" || xdev.tier === "exec";
}

/** Capabilities the prewalk coordinator borrows from its owning session. */
export interface PrewalkCoordinatorHost {
	agent: Agent;
	model(): Model | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	resolveDefaultPrewalk(): Prewalk | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	getActiveToolNames(): string[];
	waitForSessionMessagePersistence(message: AgentMessage): Promise<void>;
}

/** Initial state for the prewalk startup flow. */
export interface PrewalkCoordinatorOptions {
	prewalk?: Prewalk;
}

export type PrewalkRestartResult = "armed" | "reset" | "rejected";

/** Coordinates one-way model prewalks. */
export class PrewalkCoordinator {
	readonly #host: PrewalkCoordinatorHost;
	#prewalk: Prewalk | undefined;
	#planInjected = false;
	#continuePending = false;
	#todoSeen = false;
	#handoff:
		| {
				source: Model;
				sourceThinkingLevel: ConfiguredThinkingLevel | undefined;
				target: Model;
				targetThinkingLevel: ConfiguredThinkingLevel | undefined;
		  }
		| undefined;

	constructor(host: PrewalkCoordinatorHost, options: PrewalkCoordinatorOptions = {}) {
		this.#host = host;
		this.#prewalk = options.prewalk;
	}

	/** Current prewalk target, if the one-way switch remains armed. */
	get state(): Prewalk | undefined {
		return this.#prewalk;
	}

	/** Whether the armed prewalk would perform a model or thinking-level handoff. */
	get willHandoff(): boolean {
		const prewalk = this.#prewalk;
		return prewalk !== undefined && !this.#isNoop(prewalk);
	}

	#isNoop(prewalk: Prewalk): boolean {
		return prewalkWouldBeNoop(
			this.#host.model(),
			this.#host.configuredThinkingLevel(),
			prewalk.target,
			prewalk.thinkingLevel,
		);
	}

	#clearPrewalkState(): void {
		this.#prewalk = undefined;
		this.#planInjected = false;
		this.#continuePending = false;
		this.#todoSeen = false;
	}

	/** A later model/effort selection owns the active model, even if its identity is unchanged. */
	releaseHandoff(): void {
		this.#handoff = undefined;
	}

	/** Retire the outgoing cycle and prepare a configured prewalk for a fresh main session. */
	async resetForNewSession(enabled: boolean): Promise<void> {
		const handoff = this.#handoff;
		const current = this.#host.model();
		const restoreSource =
			enabled &&
			handoff !== undefined &&
			current?.provider === handoff.target.provider &&
			current?.id === handoff.target.id &&
			this.#host.configuredThinkingLevel() === handoff.targetThinkingLevel;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.releaseHandoff();
		if (!enabled) return;
		if (restoreSource && handoff) {
			// Best-effort: /new has already committed the transcript switch, so an
			// unusable planning model must not abort the rest of session setup.
			try {
				await this.#host.setModelTemporary(handoff.source, handoff.sourceThinkingLevel, { ephemeral: true });
				// Temporary selection treats undefined as "keep/default"; restoration must preserve
				// the original selector, including auto or an explicitly inherited effort.
				this.#host.restoreThinkingLevel(handoff.sourceThinkingLevel);
			} catch (error) {
				this.#host.emitNotice(
					"warning",
					`Prewalk: could not restore ${handoff.source.provider}/${handoff.source.id}: ${error instanceof Error ? error.message : String(error)}`,
					"prewalk",
				);
			}
		}
		const prewalk = this.#host.resolveDefaultPrewalk();
		if (!prewalk) return;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		// Like startup, inject guidance at the first completed turn, not into an empty transcript.
		this.#prewalk = prewalk;
	}

	#disarmNoop(prewalk: Prewalk): void {
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: target ${prewalk.target.provider}/${prewalk.target.id} already matches the active model and thinking level; nothing to switch.`,
			"prewalk",
		);
	}

	/** Advances the one-way prewalk switch at a completed assistant-turn boundary. */
	async advanceAtTurnEnd(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		if (this.#isNoop(prewalk)) {
			this.#scrubPlanNudge(liveMessages);
			this.#disarmNoop(prewalk);
			return;
		}
		if (context.toolResults.some(result => result.toolName === "todo" && !result.isError)) this.#todoSeen = true;

		const hasToolResults = context.toolResults.length > 0;
		if (this.#planInjected && hasToolResults) {
			this.#continuePending = true;
		} else if (this.#continuePending) {
			this.#continuePending = false;
			this.#host.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: prewalkContinuePrompt,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		const todoGateOpen = this.#todoSeen || !this.#host.getActiveToolNames().includes("todo");
		const action = todoGateOpen
			? context.toolResults.find(result => isPrewalkImplementationAction(result))
			: undefined;
		if (!action) {
			if (!this.#planInjected) {
				this.#planInjected = true;
				this.#continuePending = true;
				this.#host.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: prewalkPlanPrompt,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.#host.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#host.waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#host.waitForSessionMessagePersistence(toolResult);
		}
		this.#scrubPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		const source = this.#host.model();
		const sourceThinkingLevel = this.#host.configuredThinkingLevel();
		await this.#host.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
		if (source) {
			this.#handoff = {
				source,
				sourceThinkingLevel,
				target,
				targetThinkingLevel: this.#host.configuredThinkingLevel(),
			};
		}
		this.#host.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: prewalkChecklistPrompt,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	/** Drops a pending prewalk hand-off (e.g. `prewalk.enabled` turned off); no-op when none is armed. */
	disarm(): void {
		const active = this.#prewalk;
		if (!active) return;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: disarmed; staying on the active model instead of switching to ${active.target.provider}/${active.target.id}.`,
			"prewalk",
		);
	}

	/** Arms a prewalk immediately for an explicit slash-command request. */
	arm(target: Model, thinkingLevel?: ConfiguredThinkingLevel): boolean {
		const active = this.#prewalk;
		if (active) {
			this.#host.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return (
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel
			);
		}
		const candidate = { target, thinkingLevel };
		if (this.#isNoop(candidate)) {
			this.#disarmNoop(candidate);
			return false;
		}
		this.#prewalk = candidate;
		this.#planInjected = true;
		this.#continuePending = true;
		this.#todoSeen = false;
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
		return true;
	}

	/**
	 * Restores the planning model and reuses or creates the requested one-shot handoff.
	 * A different active arm rejects the restart before the current model changes.
	 */
	async restart(
		source: Model,
		sourceThinkingLevel: ConfiguredThinkingLevel | undefined,
		target: Model,
		targetThinkingLevel: ConfiguredThinkingLevel | undefined,
	): Promise<PrewalkRestartResult> {
		const active = this.#prewalk;
		if (
			active &&
			(active.target.provider !== target.provider ||
				active.target.id !== target.id ||
				active.thinkingLevel !== targetThinkingLevel)
		) {
			this.arm(target, targetThinkingLevel);
			return "rejected";
		}

		await this.#host.setModelTemporary(source, sourceThinkingLevel, { ephemeral: true });
		if (!active) return this.arm(target, targetThinkingLevel) ? "armed" : "reset";
		if (this.#isNoop(active)) {
			this.#scrubPlanNudge();
			this.#disarmNoop(active);
			return "reset";
		}
		return "armed";
	}

	#scrubPlanNudge(liveMessages?: AgentMessage[], includeContinuation = false): void {
		if (liveMessages) {
			for (let index = liveMessages.length - 1; index >= 0; index--) {
				if (!isPrewalkPlanNudge(liveMessages[index])) continue;
				invalidateMessageCache(liveMessages[index]);
				liveMessages.splice(index, 1);
			}
		}
		const stateMessages = this.#host.agent.state.messages;
		const filtered = stateMessages.filter(message => !isPrewalkPlanNudge(message));
		if (filtered.length !== stateMessages.length) this.#host.agent.replaceMessages(filtered);
		// Delivered continuations are persisted history; only pending ones can be canceled.
		const isPendingNudge = (message: AgentMessage): boolean =>
			isPrewalkPlanNudge(message) ||
			(includeContinuation && message.role === "custom" && message.customType === PREWALK_CONTINUE_MESSAGE_TYPE);
		const steering = this.#host.agent.peekSteeringQueue();
		if (steering.some(isPendingNudge)) {
			this.#host.agent.replaceQueue(
				"steering",
				steering.filter(message => !isPendingNudge(message)),
			);
		}
	}
}

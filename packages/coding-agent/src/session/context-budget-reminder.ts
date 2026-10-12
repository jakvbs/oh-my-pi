import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import contextBudgetReminderPrompt from "../prompts/system/context-budget-reminder.md" with { type: "text" };
import type { ContextUsage } from "../extensibility/extensions/types";

/** Ascending; the agent hears each band once per climb. */
const BANDS = [25, 50, 70, 85] as const;

/**
 * Tells the agent how full its context is when usage first reaches 25/50/70/85% of the
 * auto-compaction threshold (the model window when compaction is off). Usage that falls below the
 * announced band, after compaction or a model switch, lowers it silently so the band repeats.
 * Facts only: how to spend the remaining budget belongs to the system prompt, which knows the
 * session's tools and delegation policy.
 */
export class ContextBudgetReminder {
	#announced = -1;

	take(usage: ContextUsage | undefined): AgentMessage | null {
		if (!usage) return null;
		const limit = usage.compactionThreshold ?? usage.contextWindow;
		if (!(limit > 0)) return null;
		const percent = Math.floor((usage.tokens / limit) * 100);
		const reached = BANDS.findLastIndex(band => percent >= band);
		const previous = this.#announced;
		this.#announced = reached;
		if (reached <= previous) return null;
		return {
			role: "custom",
			customType: "context-budget-reminder",
			content: prompt.render(contextBudgetReminderPrompt, {
				tokens: usage.tokens.toLocaleString("en-US"),
				limit: limit.toLocaleString("en-US"),
				percent,
				limitKind: usage.compactionThreshold === undefined ? "context window" : "auto-compaction threshold",
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}

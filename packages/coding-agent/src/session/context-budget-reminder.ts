import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import contextBudgetReminderPrompt from "../prompts/system/context-budget-reminder.md" with { type: "text" };
import type { ContextUsage } from "../extensibility/extensions/types";

/** Ascending by `percent`; the agent hears each band once per climb. */
const BANDS = [
	{ percent: 25, advice: "Prefer targeted reads (line ranges, grep) over whole files." },
	{ percent: 50, advice: "Route bulk reads and verbose output to subagents; keep only summaries here." },
	{ percent: 70, advice: "Do not re-read what you already have; record findings in context notes." },
	{ percent: 85, advice: "Auto-compaction is close: write the current state and next steps to context notes now." },
] as const;

/**
 * Tells the agent how full its context is when usage first reaches 25/50/70/85% of the
 * auto-compaction threshold (the model window when compaction is off). Usage that falls below the
 * announced band, after compaction or a model switch, lowers it silently so the band repeats.
 */
export class ContextBudgetReminder {
	#announced = -1;

	take(usage: ContextUsage | undefined): AgentMessage | null {
		if (!usage) return null;
		const limit = usage.compactionThreshold ?? usage.contextWindow;
		if (!(limit > 0)) return null;
		const percent = Math.floor((usage.tokens / limit) * 100);
		const reached = BANDS.findLastIndex(band => percent >= band.percent);
		const previous = this.#announced;
		this.#announced = reached;
		const band = BANDS[reached];
		if (!band || reached <= previous) return null;
		return {
			role: "custom",
			customType: "context-budget-reminder",
			content: prompt.render(contextBudgetReminderPrompt, {
				tokens: usage.tokens.toLocaleString("en-US"),
				limit: limit.toLocaleString("en-US"),
				percent,
				limitKind: usage.compactionThreshold === undefined ? "context window" : "auto-compaction threshold",
				advice: band.advice,
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}

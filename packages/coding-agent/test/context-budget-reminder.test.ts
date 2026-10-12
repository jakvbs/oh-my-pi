import { describe, expect, it } from "bun:test";
import { ContextBudgetReminder } from "@oh-my-pi/pi-coding-agent/session/context-budget-reminder";

const reminders = (usages: { tokens: number; contextWindow?: number; compactionThreshold?: number }[]) => {
	const reminder = new ContextBudgetReminder();
	return usages.map(({ contextWindow = 200_000, ...usage }) => {
		const message = reminder.take({ contextWindow, percent: 0, ...usage });
		return message?.role === "custom" ? message.content : undefined;
	});
};

describe("ContextBudgetReminder", () => {
	it("announces each band of the compaction threshold once, the highest band of a jump only", () => {
		expect(
			reminders([
				{ tokens: 30_000, compactionThreshold: 160_000 },
				{ tokens: 40_000, compactionThreshold: 160_000 },
				{ tokens: 41_000, compactionThreshold: 160_000 },
				{ tokens: 140_000, compactionThreshold: 160_000 },
			]),
		).toEqual([
			undefined,
			"<system-reminder>\nContext: 40,000 of 160,000 tokens (25% of the auto-compaction threshold). Prefer targeted reads (line ranges, grep) over whole files.\n</system-reminder>",
			undefined,
			"<system-reminder>\nContext: 140,000 of 160,000 tokens (87% of the auto-compaction threshold). Auto-compaction is close: write the current state and next steps to context notes now.\n</system-reminder>",
		]);
	});

	it("repeats a band after compaction drops usage below it", () => {
		const [first, afterCompaction, again] = reminders([
			{ tokens: 120_000, compactionThreshold: 160_000 },
			{ tokens: 20_000, compactionThreshold: 160_000 },
			{ tokens: 115_000, compactionThreshold: 160_000 },
		]);
		expect(first).toContain("(75% of");
		expect(afterCompaction).toBeUndefined();
		expect(again).toContain("(71% of");
	});

	it("measures against the window when compaction is off and stays silent without a window", () => {
		const [windowOnly, unknownWindow] = [
			reminders([{ tokens: 100_000 }])[0],
			reminders([{ tokens: 100_000, contextWindow: 0 }])[0],
		];
		expect(windowOnly).toContain("100,000 of 200,000 tokens (50% of the context window)");
		expect(unknownWindow).toBeUndefined();
	});
});

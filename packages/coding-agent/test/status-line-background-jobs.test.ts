import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { StatusLineTestComponents } from "./helpers/status-line";

let settingsState: SettingsTestState | undefined;
const statusLines = new StatusLineTestComponents();

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	statusLines.dispose();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function runningJob(type: AsyncJobType, index: number): AsyncJobSnapshotItem {
	const id = `${type}-${index}`;
	return {
		id,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
	};
}

function makeComponent(running: AsyncJobSnapshotItem[]): StatusLineComponent {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const session = {
		state: { messages, model },
		messages,
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => undefined,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
	return component;
}

describe("status-line background-job badge", () => {
	it("counts every running background job", () => {
		const component = makeComponent([runningJob("bash", 0), runningJob("eval", 1)]);

		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.job} 2`);
	});
});

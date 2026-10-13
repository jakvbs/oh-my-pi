import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import {
	cfgTierAdvisor,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
} from "@oh-my-pi/pi-coding-agent/session/settings";

// Locks the back-compat migration of the legacy single `serviceTier` enum (with
// scoped `openai-only`/`claude-only` sentinels) plus
// `serviceTierAdvisor`/`fastModeScope` into the per-family `tier.*` settings.
describe("serviceTier → tier.* settings migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-service-tier-migration-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	it("expands unscoped priority to every family", async () => {
		const settings = await loadWith({ serviceTier: "priority" });
		expect(cfgTierOpenai.get(settings)).toBe("priority");
		expect(cfgTierAnthropic.get(settings)).toBe("priority");
		expect(cfgTierGoogle.get(settings)).toBe("priority");
	});

	it("scopes openai-only/claude-only to a single family", async () => {
		const openai = await loadWith({ serviceTier: "openai-only" });
		expect(cfgTierOpenai.get(openai)).toBe("priority");
		expect(cfgTierAnthropic.get(openai)).toBe("none");
		expect(cfgTierGoogle.get(openai)).toBe("none");

		const claude = await loadWith({ serviceTier: "claude-only" });
		expect(cfgTierAnthropic.get(claude)).toBe("priority");
		expect(cfgTierOpenai.get(claude)).toBe("none");
	});

	it("maps plain OpenAI tiers onto the OpenAI family", async () => {
		const settings = await loadWith({ serviceTier: "flex" });
		expect(cfgTierOpenai.get(settings)).toBe("flex");
		expect(cfgTierAnthropic.get(settings)).toBe("none");
	});

	it("carries the advisor tier over and drops scoped sentinels", async () => {
		const settings = await loadWith({
			serviceTierAdvisor: "claude-only",
		});
		expect(cfgTierAdvisor.get(settings)).toBe("priority"); // claude-only → priority
	});
});

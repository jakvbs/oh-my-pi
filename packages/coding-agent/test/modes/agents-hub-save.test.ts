import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

test("an agent saved from the hub is a discoverable TypeScript module", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hub-save-"));
	try {
		const roots = { explicit: [], configured: [], configuredLevel: "user", mode: "explicit-only" } as const;
		const deps = createAgentsHubDeps(cwd, Settings.isolated(), undefined as never, () => roots);
		const filePath = await deps.saveAgent("project", {
			identifier: "hub-saved",
			whenToUse: 'Use for "quoted" work.',
			systemPrompt: 'Line one.\n`backtick` \\ "quote"\n',
		});

		expect(filePath.endsWith(".ts")).toBe(true);
		const { agents } = await discoverAgents(cwd, os.tmpdir(), roots);
		const saved = agents.find(agent => agent.name === "hub-saved");
		expect(saved?.description).toBe('Use for "quoted" work.');
		expect(saved?.systemPrompt).toBe('Line one.\n`backtick` \\ "quote"');
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

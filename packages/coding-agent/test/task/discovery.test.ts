import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearAgentPluginRootCache } from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { clearClaudePluginRootsCache, injectPluginDirRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function agentTs(name: string, description = `${name} probe.`): string {
	return `export default ${JSON.stringify({ name, description, systemPrompt: `body ${name}` })};`;
}

const LEGACY_AGENT_MD = ["---", "name: legacy-md-agent", "description: Markdown definition.", "---", "body"].join("\n");

async function writeOmpPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".omp", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", omp: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "omp-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.ts"), agentTs("loom-verify-spec"));
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("omp-plugins");
		clearOmpExtensionCliRoots();
		await injectPluginDirRoots(tempHome, []);
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("does not inject agents into an unconfigured workspace", async () => {
		const { agents } = await discoverAgents(projectDir, tempHome);
		expect(agents).toEqual([]);
	});

	test("ignores Markdown agent definitions", async () => {
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(path.join(agentsDir, "legacy-md-agent.md"), LEGACY_AGENT_MD);
		await fs.writeFile(path.join(agentsDir, "ts-agent.ts"), agentTs("ts-agent"));

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);

		expect(agents.map(agent => agent.name)).toEqual(["ts-agent"]);
		expect(projectAgentsDir).toBe(agentsDir);
	});

	test("loads a TypeScript agent module with its session shape", async () => {
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "probe.ts"),
			`export default {
				name: "probe",
				description: "TS-defined probe.",
				systemPrompt: "You probe.",
				tools: ["read", "task"],
				model: "p/m",
				cwd: "packages/api",
				skills: ["tdd"],
				mcp: [],
			} satisfies import("@oh-my-pi/pi-coding-agent/task/types").AgentSpec;`,
		);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const probe = agents.find(agent => agent.name === "probe");

		expect(probe).toMatchObject({
			description: "TS-defined probe.",
			systemPrompt: "You probe.",
			tools: ["read", "task", "yield"],
			model: ["p/m"],
			cwd: "packages/api",
			skills: ["tdd"],
			mcp: [],
			source: "project",
		});
	});

	test("skips a TypeScript agent module with a misspelled AgentSpec key", async () => {
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "broken.ts"),
			`export default { name: "broken", description: "d", systemPrompt: "s", mcps: [] };`,
		);

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.map(agent => agent.name)).not.toContain("broken");
	});

	test("rediscovers an edited TypeScript agent module", async () => {
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		const file = path.join(agentsDir, "edited.ts");
		const write = (description: string) =>
			fs.writeFile(file, `export default { name: "edited", description: "${description}", systemPrompt: "s" };`);
		await write("before");
		await discoverAgents(projectDir, tempHome);
		await write("after");
		await fs.utimes(file, new Date(), new Date(Date.now() + 1000));

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.find(agent => agent.name === "edited")?.description).toBe("after");
	});

	test("loads agents from OMP npm plugins under <home>/.omp/plugins/node_modules", async () => {
		await writeOmpPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes OMP npm plugin agents when omp-plugins is disabled", async () => {
		await writeOmpPluginAgent(tempHome);
		disableProvider("omp-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listOmpExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/omp-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(path.join(cliExt, "agents", "collide.ts"), agentTs("collide", "from-cli"));
		await fs.writeFile(path.join(projectExt, "agents", "collide.ts"), agentTs("collide", "from-project-settings"));

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectOmpExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.ts"));
	});

	test("explicit-only CLI roots expose only explicitly named package agents", async () => {
		const staleExt = path.join(tempHome, "stale-ext");
		const explicitExt = path.join(tempHome, "explicit-ext");
		const settingsExt = path.join(tempHome, "settings-ext");
		for (const [root, name] of [
			[staleExt, "stale-agent"],
			[explicitExt, "explicit-agent"],
			[settingsExt, "settings-agent"],
		] as const) {
			await fs.mkdir(path.join(root, "agents"), { recursive: true });
			await fs.writeFile(path.join(root, "agents", `${name}.ts`), agentTs(name));
		}
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [settingsExt] }));
		await writeOmpPluginAgent(tempHome);

		injectOmpExtensionCliRoots([staleExt], tempHome, projectDir);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir, {
			mode: "explicit-only",
			replace: true,
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toEqual(expect.arrayContaining(["stale-agent", "settings-agent", "loom-verify-spec"]));
	});
});

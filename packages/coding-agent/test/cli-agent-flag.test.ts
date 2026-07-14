import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import Index from "@oh-my-pi/pi-coding-agent/commands/launch";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TEST_MODEL = getBundledModel("openai", "gpt-4o-mini");
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

afterEach(async () => {
	await Promise.all(sessions.splice(0).map(session => session.dispose()));
	for (const storage of authStorages.splice(0)) storage.close();
});

async function createRegistry(tempDir: TempDir): Promise<ModelRegistry> {
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${crypto.randomUUID()}.db`));
	authStorages.push(authStorage);
	return new ModelRegistry(authStorage, tempDir.join(`models-${crypto.randomUUID()}.yml`));
}

async function writeAgent(tempDir: TempDir, name: string, body: string, frontmatter = ""): Promise<void> {
	const file = tempDir.join(".omp", "agents", `${name}.md`);
	await fs.mkdir(tempDir.join(".omp", "agents"), { recursive: true });
	await Bun.write(file, `---\nname: ${name}\ndescription: Project profile\n${frontmatter}---\n\n${body}\n`);
}

describe("omp --agent argv", () => {
	it("parses both value forms without consuming the positional prompt", () => {
		expect(parseArgs(["--agent", "reviewer", "review this"]).agent).toBe("reviewer");
		const equals = parseArgs(["--agent=reviewer", "review this"]);
		expect(equals.agent).toBe("reviewer");
		expect(equals.messages).toEqual(["review this"]);
		expect(equals.unrecognizedFlags).toEqual([]);
	});

	it("does not regress profile bootstrap parsing", () => {
		const parsed = parseArgs(["--profile", "work", "--agent", "reviewer", "hello"]);
		expect(parsed.profile).toBe("work");
		expect(parsed.agent).toBe("reviewer");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("publishes the launch flag without an alias", () => {
		expect(Index.flags.agent.description).toBe("Start Main with a discovered agent definition");
		expect(Index.flags.agent.char).toBeUndefined();
	});
});

describe("Main agent profile projection", () => {
	it("uses the project definition and maps all portable Main fields", async () => {
		using tempDir = TempDir.createSync("@omp-main-agent-");
		await writeAgent(
			tempDir,
			"reviewer",
			"Project reviewer body",
			"tools: read, grep\nspawns: scout, reviewer\nmodel: '@slow'\nthinkingLevel: high\nreadSummarize: false\nautoloadSkills: review-skill\noutput: object\nblocking: true\n",
		);
		const settings = Settings.isolated({
			modelRoles: { slow: "openai/gpt-4o-mini" },
			"marketplace.autoUpdate": "off",
		});
		const options = await buildSessionOptions(
			parseArgs(["--cwd", tempDir.path(), "--agent", "reviewer"]),
			[],
			undefined,
			await createRegistry(tempDir),
			settings,
		);

		expect(options.customSystemPrompt).toContain("Project reviewer body");
		expect(options.toolNames).toEqual(["read", "grep", "task"]);
		expect(options.toolNames).not.toContain("yield");
		expect(options.spawns).toBe("scout,reviewer");
		expect(options.modelPattern).toEqual(["openai/gpt-4o-mini"]);
		expect(options.thinkingLevel).toBe(Effort.High);
		expect(options.autoloadSkillNames).toEqual(["review-skill"]);
		expect(options.agentProfileName).toBe("reviewer");
		expect(options.requireYieldTool).toBeUndefined();
		expect(options.outputSchema).toBeUndefined();
		expect(options.agentId).toBeUndefined();
		expect(settings.get("read.summarize.enabled")).toBe(false);
	});

	it("lets settings model overrides and explicit CLI flags win", async () => {
		using tempDir = TempDir.createSync("@omp-main-agent-precedence-");
		await writeAgent(
			tempDir,
			"security-reviewer",
			"Profile prompt",
			"tools: read, grep\nspawns: scout\nmodel: '@slow'\nthinkingLevel: high\nreadSummarize: false\nautoloadSkills: missing-skill\n",
		);
		const settings = Settings.isolated({
			modelRoles: { slow: "anthropic/claude-sonnet-4", smol: "openai/gpt-4o-mini" },
			"task.agentModelOverrides": { "security-reviewer": "@smol" },
			"marketplace.autoUpdate": "off",
		});
		const overridden = await buildSessionOptions(
			parseArgs([
				"--cwd",
				tempDir.path(),
				"--agent",
				"security-reviewer",
				"--model",
				"openai/gpt-4o-mini",
				"--thinking",
				"low",
				"--tools",
				"glob",
				"--system-prompt",
				"CLI prompt",
				"--append-system-prompt",
				"CLI append",
				"--no-skills",
			]),
			[],
			undefined,
			await createRegistry(tempDir),
			settings,
		);

		expect(overridden.model?.id).toBe("gpt-4o-mini");
		expect(overridden.modelPattern).toBeUndefined();
		expect(overridden.thinkingLevel).toBe(Effort.Low);
		expect(overridden.toolNames).toEqual(["glob"]);
		expect(overridden.customSystemPrompt).toBe("CLI prompt");
		expect(overridden.appendSystemPrompt).toBe("CLI append");
		expect(overridden.skills).toEqual([]);
		expect(overridden.autoloadSkillNames).toBeUndefined();

		const profileModel = await buildSessionOptions(
			parseArgs(["--cwd", tempDir.path(), "--agent", "security-reviewer"]),
			[],
			undefined,
			await createRegistry(tempDir),
			settings,
		);
		expect(profileModel.modelPattern).toEqual(["openai/gpt-4o-mini"]);

		const noTools = await buildSessionOptions(
			parseArgs(["--cwd", tempDir.path(), "--agent", "security-reviewer", "--no-tools"]),
			[],
			undefined,
			await createRegistry(tempDir),
			settings,
		);
		expect(noTools.toolNames).toEqual([]);
	});

	it("rejects disabled and unknown agents with public startup messages", async () => {
		using tempDir = TempDir.createSync("@omp-main-agent-errors-");
		const registry = await createRegistry(tempDir);
		await expect(
			buildSessionOptions(
				parseArgs(["--cwd", tempDir.path(), "--agent", "reviewer"]),
				[],
				undefined,
				registry,
				Settings.isolated({ "task.disabledAgents": ["reviewer"] }),
			),
		).rejects.toThrow('Agent "reviewer" is disabled in settings. Enable it via /agents or choose another agent.');

		const unknown = buildSessionOptions(
			parseArgs(["--cwd", tempDir.path(), "--agent", "__missing_agent__"]),
			[],
			undefined,
			registry,
			Settings.isolated(),
		);
		await expect(unknown).rejects.toThrow(
			'Unknown agent "__missing_agent__". Available: designer, librarian, reviewer, scout, sonic, task',
		);
	});

	it("preserves baseline options when --agent is absent", async () => {
		using tempDir = TempDir.createSync("@omp-main-agent-baseline-");
		const options = await buildSessionOptions(
			parseArgs(["--cwd", tempDir.path()]),
			[],
			undefined,
			await createRegistry(tempDir),
			Settings.isolated(),
		);
		expect(options.agentProfileName).toBeUndefined();
		expect(options.autoloadSkillNames).toBeUndefined();
		expect(options.toolNames).toBeUndefined();
		expect(options.customSystemPrompt).toBeUndefined();
	});
});

describe("Main agent profile skill autoload", () => {
	it("injects a known skill before first input and rejects a missing skill", async () => {
		using tempDir = TempDir.createSync("@omp-main-agent-skill-");
		const skillDir = tempDir.join("review-skill");
		await fs.mkdir(skillDir, { recursive: true });
		const skillPath = tempDir.join("review-skill", "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: review-skill\ndescription: Review carefully\n---\n\nKnown autoload body.\n",
		);
		const registry = await createRegistry(tempDir);
		const base = {
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: registry,
			model: TEST_MODEL,
			settings: Settings.isolated({ "async.enabled": false }),
			skills: [
				{
					name: "review-skill",
					description: "Review carefully",
					filePath: skillPath,
					baseDir: skillDir,
					source: "custom" as const,
				},
			],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: tempDir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		};
		const { session } = await createAgentSession({
			...base,
			agentProfileName: "reviewer",
			autoloadSkillNames: ["review-skill"],
		});
		sessions.push(session);
		const autoload = session.messages.find(
			(message): message is CustomMessage =>
				"customType" in message && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
		);
		expect(autoload?.content).toContain("Known autoload body.");

		await expect(
			createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				agentProfileName: "reviewer",
				autoloadSkillNames: ["missing-skill"],
			}),
		).rejects.toThrow('Agent profile "reviewer" requires missing skill "missing-skill".');
	});
});

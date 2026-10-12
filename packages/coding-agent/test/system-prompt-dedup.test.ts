import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("project context assembly", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("keeps per-request date/cwd out of the system prompt footer", async () => {
		// The date/cwd line was moved out of the system prompt and onto the first
		// user turn (#7404): any byte that changes per request at the tail of the
		// system block invalidates the tool-schema prefix cache on open-weight
		// providers. The footer must not interpolate the cwd or the date.
		const projectDir = path.join(os.homedir(), "project");
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			activeRepoContext: null,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		const normalizedProjectDir = projectDir.replace(/\\/g, "/");
		expect(promptText).not.toContain(normalizedProjectDir);
		expect(promptText).not.toContain("Today");
		expect(promptText).not.toContain("current working directory");
	});

	it("lists nested AGENTS.md in <dir-context> when the workspace tree is not rendered", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, "packages", "lib"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "packages", "lib", "AGENTS.md"), "Nested package rules");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles: [{ path: path.join(projectDir, "AGENTS.md"), content: "Root rules" }],
			skills: [],
			rules: [],
			toolNames: [],
			activeRepoContext: null,
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain("<dir-context>");
		expect(promptText).toContain("packages/lib/AGENTS.md");
		expect(promptText).not.toContain("<workspace-tree>");
	});

	it("renders active child repo context in the main system prompt", async () => {
		const parentDir = path.join(tempDir, "parent-cwd");
		fs.mkdirSync(path.join(parentDir, "active-project", ".git"), { recursive: true });
		fs.writeFileSync(path.join(parentDir, "active-project", ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: parentDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: parentDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain("`active-project/`");
	});

	it("drops identical explicit context entries even when file names differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");
		const sharedContent = "Shared context instructions";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			systemPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: sharedContent, depth: 2 },
				{ path: nearPath, content: sharedContent, depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(promptText).not.toContain(`<file path="${farPath}">`);
		expect(promptText).toContain(`<file path="${nearPath}">`);
	});

	it("drops identical discovered context entries and keeps the closest copy", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";

		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});

	it("keeps distinct context entries when their contents differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			systemPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: "Root context instructions", depth: 2 },
				{ path: nearPath, content: "Near context instructions", depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Root context instructions");
		expect(promptText).toContain("Near context instructions");
	});
});

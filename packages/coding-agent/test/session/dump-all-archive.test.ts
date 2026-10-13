/**
 * Contract: `/dump all` writes a zip holding the main `/dump` transcript and the
 * LLM request; the anonymized variant writes the session JSONL with malformed
 * records reported.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function subagentJsonl(id: string, userText: string | null): string {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (userText !== null) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: `${id}-m`,
				parentId: null,
				timestamp: "2026-10-01T00:00:01.000Z",
				model: "anthropic/claude-x",
			}),
			JSON.stringify({
				type: "message",
				id: `${id}-u`,
				parentId: `${id}-m`,
				timestamp: "2026-10-01T00:00:02.000Z",
				message: { role: "user", content: userText, timestamp: 2 },
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

describe("AgentSession.dumpSessionArchiveToTmpDir", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const archives: string[] = [];

	function createSession(prompt: string): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const authStorage = createInMemoryAuthStorage();
		return new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: prompt, timestamp: 1 }],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			advisorTools: [],
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dump-all-");
		session = createSession("main prompt");
	});

	afterEach(async () => {
		await session.dispose();
		for (const archive of archives.splice(0)) await fs.rm(archive, { force: true });
		await tempDir.remove();
	});

	it("archives the main dump and the LLM request", async () => {
		const archive = await session.dumpSessionArchiveToTmpDir();
		if (!archive) throw new Error("Expected an archive");
		archives.push(archive.path);

		expect(archive.files).toEqual(["session.md", "llm-request.json"]);
		const entries = await readArchiveEntries({ bytes: await Bun.file(archive.path).bytes(), format: "zip" });
		expect(new TextDecoder().decode(entries.get("session.md"))).toContain("main prompt");
	});

	it("writes anonymized session JSONL without the original text", async () => {
		const archive = await session.dumpAnonymizedArchiveToTmpDir();
		if (!archive) throw new Error("Expected an archive");
		archives.push(archive.path);

		expect(archive.anonymized).toBe(true);
		expect(archive.files).toEqual(["session.jsonl"]);
		const entries = await readArchiveEntries({ bytes: await Bun.file(archive.path).bytes(), format: "zip" });
		expect(new TextDecoder().decode(entries.get("session.jsonl"))).not.toContain("main prompt");
	});

	it("reports malformed records skipped while loading the main session", async () => {
		const file = path.join(tempDir.path(), "corrupt.jsonl");
		await Bun.write(file, `${subagentJsonl("main", "hello")}{"type":"message","id":"broken`);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const reopened = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: [],
					tools: [],
					messages: [{ role: "user", content: "x", timestamp: 1 }],
				},
			}),
			sessionManager: await SessionManager.open(file, tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
			advisorTools: [],
		});
		try {
			const archive = await reopened.dumpAnonymizedArchiveToTmpDir();
			if (!archive) throw new Error("Expected an archive");
			archives.push(archive.path);
			expect(archive.malformed).toEqual([["session.jsonl", 1]]);
		} finally {
			await reopened.dispose();
		}
	});

	it("returns undefined when the main session has no messages", async () => {
		session.agent.state.messages = [];
		expect(await session.dumpSessionArchiveToTmpDir()).toBeUndefined();
	});
});

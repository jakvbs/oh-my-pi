import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
	} satisfies ToolSession;
}

const text = (result: { content: readonly { type: string; text?: string }[] }) =>
	result.content.map(part => part.text ?? "").join("\n");

// Regression: a session started in one checkout editing another worktree. bash takes `cwd`;
// edit and grep resolved relative paths against the session cwd only, failed with
// "File not found", and agents fell back to `python3 - <<EOF` / `sed -i` edits through bash.
describe("cwd for edit and grep", () => {
	let sessionDir: string;
	let worktree: string;

	beforeEach(async () => {
		sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-session-"));
		worktree = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-worktree-"));
		await fs.mkdir(path.join(worktree, "src"));
		await fs.writeFile(path.join(worktree, "src", "x.ts"), "alpha\nbeta\n");
	});

	afterEach(async () => {
		await removeWithRetries(sessionDir);
		await removeWithRetries(worktree);
	});

	it("replace mode resolves a relative path against cwd", async () => {
		const result = await new EditTool(createSession(sessionDir), "replace").execute("e1", {
			path: "src/x.ts",
			old_string: "beta",
			new_string: "delta",
			cwd: worktree,
		});

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(path.join(worktree, "src", "x.ts")).text()).toBe("alpha\ndelta\n");
	});

	it("patch mode resolves path and rename against cwd", async () => {
		const result = await new EditTool(createSession(sessionDir), "patch").execute("e2", {
			path: "src/x.ts",
			edits: [{ op: "update", rename: "src/y.ts", diff: "@@\n alpha\n-beta\n+delta\n" }],
			cwd: worktree,
		});

		expect(text(result)).not.toContain("not found");
		expect(await Bun.file(path.join(worktree, "src", "y.ts")).text()).toBe("alpha\ndelta\n");
		expect(await Bun.file(path.join(worktree, "src", "x.ts")).exists()).toBe(false);
	});

	it("without cwd a relative path still resolves against the session cwd", async () => {
		const result = await new EditTool(createSession(sessionDir), "replace").execute("e3", {
			path: "src/x.ts",
			old_string: "beta",
			new_string: "delta",
		});

		expect(result.isError).toBe(true);
		expect(await Bun.file(path.join(worktree, "src", "x.ts")).text()).toBe("alpha\nbeta\n");
	});

	it("approval sees the rebased target", () => {
		const tool = new EditTool(createSession(sessionDir), "replace");

		expect(tool.matcherPaths({ path: "src/x.ts", old_string: "a", new_string: "b", cwd: worktree })).toEqual([
			path.join(worktree, "src", "x.ts"),
		]);
	});

	it("grep searches a relative path under cwd and reports paths relative to it", async () => {
		const result = await new GrepTool(createSession(sessionDir)).execute("g1", {
			pattern: "beta",
			path: "src",
			cwd: worktree,
		});

		expect(text(result)).toContain("x.ts");
		expect(text(result)).not.toContain(worktree);
	});
});

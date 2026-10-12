import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

test("reports Markdown links to removed paths but not prose, prefixes, or changelogs", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "check-fork-removed-"));
	try {
		await fs.mkdir(path.join(cwd, "scripts"));
		await fs.copyFile(
			path.join(import.meta.dir, "check-fork-removed.ts"),
			path.join(cwd, "scripts", "check-fork-removed.ts"),
		);
		await Bun.write(path.join(cwd, "scripts", "fork-removed-paths.txt"), "infra\npkg/src/claude.ts\n");
		await Bun.write(
			path.join(cwd, "docs", "a.md"),
			"Our infrastructure is fine.\nSee [claude](../pkg/src/claude.ts) and pkg/src/claude.tsx.\n",
		);
		await Bun.write(path.join(cwd, "CHANGELOG.md"), "- Removed `pkg/src/claude.ts`.\n");
		await $`git init -q && git add -A`.cwd(cwd).quiet();

		const result = await $`bun scripts/check-fork-removed.ts`.cwd(cwd).nothrow().quiet();

		expect({ exitCode: result.exitCode, stderr: result.stderr.toString().split("\n").slice(0, 3) }).toEqual({
			exitCode: 1,
			stderr: [
				"These Markdown files still reference paths the fork removed:",
				"  docs/a.md: pkg/src/claude.ts",
				"Rewrite or drop the reference; the path is listed in scripts/fork-removed-paths.txt.",
			],
		});
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

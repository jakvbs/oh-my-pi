import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const SCRIPTS = ["sync-upstream.ts", "check-fork-removed.ts"];

test("leaves lockfiles alone while a manifest still conflicts and lists the conflict", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-"));
	try {
		await fs.mkdir(path.join(cwd, "scripts"));
		for (const script of SCRIPTS)
			await fs.copyFile(path.join(import.meta.dir, script), path.join(cwd, "scripts", script));
		await Bun.write(path.join(cwd, "scripts", "fork-removed-paths.txt"), "");
		const git = (args: string[]) =>
			$`git -c user.name=t -c user.email=t@example.test -c commit.gpgsign=false ${args}`.cwd(cwd).quiet();
		await git(["init", "-q", "-b", "main"]);
		await Bun.write(path.join(cwd, "package.json"), '{ "name": "base" }\n');
		await Bun.write(path.join(cwd, "bun.lock"), "base lock\n");
		await git(["add", "-A"]);
		await git(["commit", "-q", "-m", "base"]);
		await git(["checkout", "-q", "-b", "upstream"]);
		await Bun.write(path.join(cwd, "package.json"), '{ "name": "upstream" }\n');
		await Bun.write(path.join(cwd, "bun.lock"), "upstream lock\n");
		await git(["commit", "-q", "-am", "upstream"]);
		await git(["checkout", "-q", "main"]);
		await Bun.write(path.join(cwd, "package.json"), '{ "name": "fork" }\n');
		await git(["commit", "-q", "-am", "fork"]);
		await git(["merge", "--no-ff", "--no-commit", "upstream"]).nothrow();

		const result = await $`bun scripts/sync-upstream.ts --continue`.cwd(cwd).nothrow().quiet();

		expect({
			exitCode: result.exitCode,
			stderr: result.stderr.toString().trim().split("\n").slice(0, 2),
			lock: await Bun.file(path.join(cwd, "bun.lock")).text(),
		}).toEqual({
			exitCode: 1,
			stderr: ["Merge left for manual resolution:", "  conflict: package.json"],
			lock: "upstream lock\n",
		});
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

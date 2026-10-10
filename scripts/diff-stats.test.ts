import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { diffStats } from "./diff-stats";

test("reports endpoint totals rather than gross removals or commit churn, excluding binary lines", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "diff-stats-"));
	try {
		await $`git init -q ${cwd}`.quiet();
		const repo = vcs.requireGit(cwd);
		await repo.configSet("user.name", "Diff Stats Test");
		await repo.configSet("user.email", "diff-stats@example.test");
		await repo.configSet("commit.gpgsign", "false");
		await repo.configSet("core.autocrlf", "false");
		await Bun.write(path.join(cwd, "removed.txt"), "old line\n".repeat(4232));
		await repo.stageFiles(["removed.txt"]);
		const base = await repo.commitCreate("base", {});
		await Bun.write(path.join(cwd, "temporary.txt"), "temporary line\n".repeat(100));
		await repo.stageFiles(["temporary.txt"]);
		await repo.commitCreate("intermediate churn", {});
		await fs.rm(path.join(cwd, "temporary.txt"));
		await fs.rm(path.join(cwd, "removed.txt"));
		await Bun.write(path.join(cwd, "added.txt"), "new line\n".repeat(15));
		await Bun.write(path.join(cwd, "binary.dat"), new Uint8Array([0, 1, 2]));
		await repo.stageFiles(["temporary.txt", "removed.txt", "added.txt", "binary.dat"]);
		const head = await repo.commitCreate("prune", {});
		await Bun.write(path.join(cwd, "added.txt"), "uncommitted changes must not count\n");
		const result = await $`${process.execPath} ${path.join(import.meta.dir, "diff-stats.ts")} ${base} ${head}`
			.cwd(cwd)
			.quiet();
		expect(result.json()).toEqual({
			comparison: "endpoint-trees",
			base: { ref: base, commit: base },
			head: { ref: head, commit: head },
			files: 3,
			binaryFiles: 1,
			added: 15,
			removed: 4232,
			net: -4217,
		});
		expect(await diffStats(cwd, head, base)).toMatchObject({ added: 4232, removed: 15, net: 4217 });
		const invalid =
			await $`${process.execPath} ${path.join(import.meta.dir, "diff-stats.ts")} no-such-revision ${head}`
				.cwd(cwd)
				.quiet()
				.nothrow();
		expect(invalid.exitCode).not.toBe(0);
		expect(invalid.stdout.toString()).toBe("");
		const noRange = await $`${process.execPath} ${path.join(import.meta.dir, "diff-stats.ts")}`
			.cwd(cwd)
			.quiet()
			.nothrow();
		expect(noRange.exitCode).toBe(1);
		expect(noRange.stderr.toString()).toContain("BASE HEAD");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

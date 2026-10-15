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

async function prepareMerge(cwd: string, changesTrackedFile: boolean): Promise<void> {
	await fs.mkdir(path.join(cwd, "scripts"));
	for (const file of SCRIPTS) {
		await fs.copyFile(path.join(import.meta.dir, file), path.join(cwd, "scripts", file));
	}
	await Bun.write(path.join(cwd, "scripts/fork-removed-paths.txt"), "");
	await Bun.write(path.join(cwd, ".gitignore"), ".prepare-ran\nnode_modules/\n");
	await Bun.write(
		path.join(cwd, "package.json"),
		JSON.stringify({
			name: "sync-fixture",
			dependencies: { "fixture-dep": "file:./dependency" },
			scripts: { prepare: "bun prepare.ts" },
		}),
	);
	await Bun.write(
		path.join(cwd, "prepare.ts"),
		`await Bun.write(".prepare-ran", "ran\\n");\n${changesTrackedFile ? 'await Bun.write("generated.txt", "generated\\n");\n' : ""}`,
	);
	await Bun.write(path.join(cwd, "generated.txt"), "original\n");
	await Bun.write(path.join(cwd, "source file.ts"), "original\n");
	await Bun.write(
		path.join(cwd, "dependency/package.json"),
		JSON.stringify({ name: "fixture-dep", version: "1.0.0" }),
	);
	await $`bun install --ignore-scripts`.cwd(cwd).quiet();
	await $`git init -q -b main && git config user.name Fixture && git config user.email fixture@example.com && git config commit.gpgsign false && git config core.hooksPath /dev/null && git add . && git commit -qm base && git checkout -qb upstream/main`
		.cwd(cwd)
		.quiet();
	await Bun.write(path.join(cwd, "source file.ts"), "upstream\n");
	await fs.appendFile(path.join(cwd, "bun.lock"), "\n");
	await $`git add . && git commit -qm upstream && git checkout -q main && git merge --no-ff --no-commit upstream/main`
		.cwd(cwd)
		.quiet();
}

for (const changesTrackedFile of [false, true]) {
	test(
		changesTrackedFile
			? "refuses tracked changes from lock regeneration until explicitly staged"
			: "refuses unstaged resolutions identical to HEAD before regenerating locks",
		async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-"));
			try {
				await prepareMerge(cwd, changesTrackedFile);
				const head = await $`git rev-parse HEAD`.cwd(cwd).quiet().text();
				const upstream = await $`git rev-parse MERGE_HEAD`.cwd(cwd).quiet().text();
				if (!changesTrackedFile) {
					await Bun.write(path.join(cwd, "source file.ts"), "original\n");
					expect(await $`git diff HEAD -- ${"source file.ts"}`.cwd(cwd).quiet().text()).toBe("");
				}
				const refused = await $`${process.execPath} scripts/sync-upstream.ts --continue`.cwd(cwd).quiet().nothrow();
				expect(refused.exitCode).toBe(1);
				const unstaged = changesTrackedFile ? "generated.txt" : "source file.ts";
				expect(refused.stderr.toString()).toContain(JSON.stringify(unstaged));
				expect(refused.stderr.toString()).toContain("git add");
				expect(await $`git rev-parse HEAD`.cwd(cwd).quiet().text()).toBe(head);
				expect(await $`git rev-parse MERGE_HEAD`.cwd(cwd).quiet().text()).toBe(upstream);
				expect(await Bun.file(path.join(cwd, ".prepare-ran")).exists()).toBe(changesTrackedFile);
				await $`git add -- ${unstaged}`.cwd(cwd).quiet();
				const completed = await $`${process.execPath} scripts/sync-upstream.ts --continue`
					.cwd(cwd)
					.quiet()
					.nothrow();
				expect(completed.exitCode, completed.stderr.toString()).toBe(0);
				expect(await $`git show HEAD:${unstaged}`.cwd(cwd).quiet().text()).toBe(
					changesTrackedFile ? "generated\n" : "original\n",
				);
				expect(await $`git rev-parse HEAD^1 HEAD^2`.cwd(cwd).quiet().text()).toBe(`${head}${upstream}`);
				expect(await Bun.file(path.join(cwd, ".prepare-ran")).text()).toBe("ran\n");
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
		30_000,
	);
}

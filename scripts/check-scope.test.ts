import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { runChecks, scopeChecks } from "./check-scope";

const root = path.resolve(import.meta.dir, "..");

test("a checker failure without diagnostics blocks later checks and keeps its complete log", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-test-"));
	try {
		const marker = path.join(dir, "should-not-run");
		const code = await runChecks(
			[
				{
					label: "bootstrap failure",
					cwd: root,
					command: [process.execPath, "-e", 'console.error("checker bootstrap failed"); process.exit(7)'],
				},
				{
					label: "next check",
					cwd: root,
					command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`],
				},
			],
			dir,
		);
		expect(code).toBe(7);
		expect(await Bun.file(path.join(dir, "1.log")).text()).toContain("checker bootstrap failed");
		expect(await Bun.file(marker).exists()).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("missing executables and real lint findings fail; a corrected file passes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-lint-"));
	try {
		expect(
			await runChecks([{ label: "missing checker", cwd: root, command: [path.join(dir, "missing")] }], dir),
		).not.toBe(0);
		const file = path.join(dir, "fixture.ts");
		await Bun.write(file, "const unused = 1;\n");
		const lint = {
			label: "lint",
			cwd: root,
			command: [path.join(root, "node_modules/.bin/oxlint"), "--deny-warnings", "--deny", "no-unused-vars", file],
		};
		expect(await runChecks([lint], dir)).not.toBe(0);
		expect(await Bun.file(path.join(dir, "1.log")).text()).toContain("no-unused-vars");
		await Bun.write(file, "export const used = 1;\n");
		expect(await runChecks([lint], dir)).toBe(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("scope CLI rejects an empty or invalid scope and normalizes in-repo parent segments", async () => {
	const result = await $`${process.execPath} ${path.join(import.meta.dir, "check-scope.ts")}`.quiet().nothrow();
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("Select --package");
	await expect(scopeChecks(["--package", "../coding-agent"])).rejects.toThrow("Invalid package");
	await expect(scopeChecks(["--all", "--file", "package.json"])).rejects.toThrow("not both");
	const checks = await scopeChecks(["--file", "packages/coding-agent/../../scripts/check-scope.ts"]);
	expect(checks[0]?.command).toContain("scripts/check-scope.ts");
});

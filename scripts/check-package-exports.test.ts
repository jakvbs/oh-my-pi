import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

test("rejects deleted agentic-commit and stats exports and accepts existing nested targets", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "check-package-exports-"));
	const staleExports = {
		"coding-agent": { "./commit/agentic": { import: "./src/commit/agentic/index.ts" } },
		stats: { "./client/components/*": "./src/client/components/*.ts" },
	};
	try {
		await fs.mkdir(path.join(cwd, "scripts"));
		await fs.copyFile(
			path.join(import.meta.dir, "check-package-exports.ts"),
			path.join(cwd, "scripts", "check-package-exports.ts"),
		);
		for (const [name, exports] of Object.entries(staleExports)) {
			await Bun.write(path.join(cwd, "packages", name, "package.json"), JSON.stringify({ exports }));
		}
		const failed = await $`${process.execPath} scripts/check-package-exports.ts`.cwd(cwd).nothrow().quiet();
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr.toString()).toContain(
			'packages/coding-agent: "./commit/agentic" -> ./src/commit/agentic/index.ts',
		);
		expect(failed.stderr.toString()).toContain(
			'packages/stats: "./client/components/*" -> ./src/client/components/*.ts',
		);

		for (const name of Object.keys(staleExports)) {
			await Bun.write(
				path.join(cwd, "packages", name, "package.json"),
				JSON.stringify({ exports: { "./*": { types: "./src/*.ts", import: "./src/*.ts" } } }),
			);
			await Bun.write(path.join(cwd, "packages", name, "src", "nested", "live.ts"), "export {};\n");
		}
		const passed = await $`${process.execPath} scripts/check-package-exports.ts`.cwd(cwd).nothrow().quiet();
		expect(passed.exitCode).toBe(0);
		expect(passed.stderr.toString()).toBe("");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { verifyHostAddonLoads } from "../../../scripts/bazel-natives";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import { checkGeneratedBindings, generateEnumExports, nativeExportNames } from "../scripts/gen-enums";

const nativeDir = path.resolve(import.meta.dir, "../native");

test("the host addon implements declared exports and rejects a removed AST export", async () => {
	const addon = path.join(
		nativeDir,
		resolveLocalHostAddon({
			platform: process.platform,
			arch: process.arch,
			avx2: detectHostAvx2Support(),
		}).filename,
	);
	const declarations = await Bun.file(path.join(nativeDir, "index.d.ts")).text();
	const names = nativeExportNames(declarations);
	expect(names).toContain("astMatch");
	await verifyHostAddonLoads(addon, undefined, undefined, names);
	await expect(verifyHostAddonLoads(addon, undefined, undefined, [...names, "astGrep"])).rejects.toThrow(
		"Native addon lacks exports: astGrep",
	);
});

test("generation is reproducible and check mode rejects hand-edited bindings without overwriting them", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bindings-contract-"));
	try {
		for (const name of ["index.d.ts", "index.js"]) {
			await fs.copyFile(path.join(nativeDir, name), path.join(dir, name));
		}
		await generateEnumExports(dir);
		await checkGeneratedBindings(dir);
		const dts = await Bun.file(path.join(dir, "index.d.ts")).text();
		const removedExport = `${dts}\nexport declare function astGrep(): void\n`;
		await Bun.write(path.join(dir, "index.d.ts"), removedExport);
		await expect(checkGeneratedBindings(dir)).rejects.toThrow("index.d.ts differs");
		expect(await Bun.file(path.join(dir, "index.d.ts")).text()).toBe(removedExport);
		await Bun.write(path.join(dir, "index.d.ts"), dts);
		await Bun.write(path.join(dir, "index.js"), "export const astGrep = undefined;\n");
		await expect(checkGeneratedBindings(dir)).rejects.toThrow("index.js differs");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

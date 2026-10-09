#!/usr/bin/env bun

/**
 * Fails when a workspace package.json `exports` entry points at a file or
 * pattern that no longer exists. Deleting a module without its export entry
 * still typechecks, but the compiled binary bundle resolves every coding-agent
 * export and fails late in the install-method job.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGES_DIR = path.join(import.meta.dir, "..", "packages");

function exportTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (value === null || typeof value !== "object") return [];
	return Object.values(value).flatMap(exportTargets);
}

function targetExists(packageDir: string, target: string): boolean {
	const relative = target.replace(/^\.\//, "");
	if (!relative.includes("*")) return fs.existsSync(path.join(packageDir, relative));
	for (const _ of new Bun.Glob(relative).scanSync({ cwd: packageDir, onlyFiles: true })) return true;
	return false;
}

const missing: string[] = [];
for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
	const packageDir = path.join(PACKAGES_DIR, entry.name);
	const manifest = path.join(packageDir, "package.json");
	if (!entry.isDirectory() || !fs.existsSync(manifest)) continue;
	const { exports } = await Bun.file(manifest).json();
	const entries = typeof exports === "string" ? [[".", exports]] : Object.entries(exports ?? {});
	for (const [subpath, value] of entries) {
		for (const target of new Set(exportTargets(value))) {
			if (!targetExists(packageDir, target)) missing.push(`packages/${entry.name}: "${subpath}" -> ${target}`);
		}
	}
}

if (missing.length > 0) {
	console.error("package.json exports point at missing files; remove or fix these entries:");
	for (const line of missing) console.error(`  ${line}`);
	process.exit(1);
}

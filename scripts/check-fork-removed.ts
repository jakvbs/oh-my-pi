#!/usr/bin/env bun

/**
 * Fails while any path listed in scripts/fork-removed-paths.txt exists, or a
 * tracked Markdown file (changelogs aside) still names one. An upstream merge
 * re-adds files under a removed directory without a conflict, so the fork
 * would silently grow a feature back; docs keep describing it after deletion.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

export const REPO_ROOT = path.join(import.meta.dir, "..");
export const REMOVED_PATHS_FILE = path.join(REPO_ROOT, "scripts", "fork-removed-paths.txt");

export function readRemovedPaths(): string[] {
	return fs
		.readFileSync(REMOVED_PATHS_FILE, "utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"));
}

export function presentRemovedPaths(): string[] {
	return readRemovedPaths().filter(entry => fs.existsSync(path.join(REPO_ROOT, entry)));
}

/** `file: removed/path` for each Markdown reference to a removed path, matched as a whole path token. */
export async function staleDocReferences(): Promise<string[]> {
	const escaped = readRemovedPaths().map(entry => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (escaped.length === 0) return [];
	const pattern = new RegExp(`(?:^|[\\s\`(\\["'])(?:\\.\\.?/)*(${escaped.join("|")})(?![\\w.-])`, "gm");
	const files = (await $`git ls-files -- '*.md'`.cwd(REPO_ROOT).quiet().text())
		.split("\n")
		.filter(file => file.length > 0 && !file.endsWith("CHANGELOG.md"));
	const stale: string[] = [];
	for (const file of files) {
		const text = await Bun.file(path.join(REPO_ROOT, file)).text();
		for (const match of text.matchAll(pattern)) stale.push(`${file}: ${match[1]}`);
	}
	return stale;
}

if (import.meta.main) {
	const stale = await staleDocReferences();
	if (stale.length > 0) {
		console.error("These Markdown files still reference paths the fork removed:");
		for (const entry of stale) console.error(`  ${entry}`);
		console.error("Rewrite or drop the reference; the path is listed in scripts/fork-removed-paths.txt.");
		process.exitCode = 1;
	}
	const present = presentRemovedPaths();
	if (present.length > 0) {
		console.error(
			"The fork removed these paths, but they exist again (an upstream merge re-added files under them):",
		);
		for (const entry of present) console.error(`  ${entry}`);
		console.error(
			"Delete them with `git rm -r -- <path>` and drop the code that references them, or remove the entry from scripts/fork-removed-paths.txt to restore the feature.",
		);
		process.exit(1);
	}
}

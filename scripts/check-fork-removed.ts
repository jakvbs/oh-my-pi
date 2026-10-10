#!/usr/bin/env bun

/**
 * Fails while any path listed in scripts/fork-removed-paths.txt exists.
 * An upstream merge re-adds files under a removed directory without a
 * conflict, so the fork would silently grow a feature back.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

if (import.meta.main) {
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

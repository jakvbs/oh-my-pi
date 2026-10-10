#!/usr/bin/env bun

/**
 * Merges `upstream/main` into the fork and settles the conflicts a maintained
 * fork always hits: files the fork deleted, files upstream re-added under a
 * removed directory, and lockfiles.
 *
 * The fork merges instead of rebasing: a rebase replays every fork commit on
 * every sync and re-resolves the same conflicts each time; a merge resolves
 * each upstream change once and keeps commit SHAs stable across machines.
 *
 * Usage:
 *   bun scripts/sync-upstream.ts             # fetch, merge, auto-resolve, commit
 *   bun scripts/sync-upstream.ts --continue  # after resolving leftover conflicts by hand
 *
 * Exit 1 leaves the merge in progress with the remaining conflicts listed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { presentRemovedPaths, readRemovedPaths, REPO_ROOT } from "./check-fork-removed";

$.cwd(REPO_ROOT);

// Taking upstream's lockfile and regenerating keeps upstream's pins; merging
// lockfile text by hand or keeping the fork's copy drifts from them.
const LOCKFILES = ["bun.lock", "Cargo.lock", "MODULE.bazel.lock"];
const UPSTREAM_LOCK_DRIVER = "upstream-lock";

const continueMerge = process.argv.includes("--continue");

async function lines(output: Promise<{ text(): string }>): Promise<string[]> {
	return (await output)
		.text()
		.split("\n")
		.filter(line => line.length > 0);
}

async function configureGit(): Promise<void> {
	// Recorded resolutions replay when the same hunk conflicts again (hot upstream files).
	await $`git config rerere.enabled true`;
	await $`git config rerere.autoupdate true`;
	await $`git config merge.${UPSTREAM_LOCK_DRIVER}.name ${"take upstream lockfile, regenerate afterwards"}`;
	await $`git config merge.${UPSTREAM_LOCK_DRIVER}.driver ${"cp -f %B %A"}`;
}

async function mergeUpstream(): Promise<void> {
	const dirty = await lines($`git status --porcelain --untracked-files=no`.quiet());
	if (dirty.length > 0) {
		console.error("Working tree has uncommitted changes; commit or stash them before syncing.");
		process.exit(1);
	}
	await $`git fetch upstream main`;
	const ancestor = await $`git merge-base --is-ancestor upstream/main HEAD`.nothrow().quiet();
	if (ancestor.exitCode === 0) {
		console.log("upstream/main is already merged.");
		process.exit(0);
	}
	await $`git merge --no-ff --no-commit upstream/main`.nothrow();
}

/** Resolves modify/delete conflicts on files the fork deleted: the file stays deleted. */
async function dropFilesDeletedByFork(): Promise<string[]> {
	const unmerged = await lines($`git ls-files --unmerged`.quiet());
	const stages = new Map<string, Set<string>>();
	for (const entry of unmerged) {
		const [meta, file] = entry.split("\t");
		const stage = meta?.split(" ")[2];
		if (!file || !stage) continue;
		stages.set(file, (stages.get(file) ?? new Set()).add(stage));
	}
	const dropped: string[] = [];
	for (const [file, present] of stages) {
		if (present.has("2")) continue;
		await $`git rm -q -- ${file}`.quiet();
		dropped.push(file);
	}
	return dropped;
}

/** Removes files upstream re-added under a directory the fork removed (merged without conflict). */
async function dropReaddedRemovedPaths(): Promise<string[]> {
	const dropped: string[] = [];
	for (const entry of readRemovedPaths()) {
		const tracked = await lines($`git ls-files -- ${entry}`.quiet());
		if (tracked.length === 0) continue;
		await $`git rm -r -q -f -- ${entry}`.quiet();
		dropped.push(entry);
	}
	return dropped;
}

async function regenerateLockfiles(): Promise<string[]> {
	// Generators parse manifests (package.json, Cargo.toml) that may still hold
	// conflict markers; `--continue` regenerates once every conflict is resolved.
	const conflicts = await lines($`git diff --name-only --diff-filter=U`.quiet());
	if (conflicts.some(file => !LOCKFILES.includes(file))) return [];
	const changed = await lines($`git diff --name-only HEAD -- ${LOCKFILES}`.quiet());
	const unmerged = await lines($`git diff --name-only --diff-filter=U -- ${LOCKFILES}`.quiet());
	const touched = new Set([...changed, ...unmerged]);
	if (touched.has("bun.lock")) {
		await $`bun install`;
		await $`git add bun.lock`;
	}
	if (touched.has("Cargo.lock")) {
		await $`cargo metadata --format-version 1`.quiet();
		await $`git add Cargo.lock`;
	}
	const cargoInputs = await lines($`git diff --name-only --cached HEAD -- Cargo.toml Cargo.lock crates`.quiet());
	if (touched.has("MODULE.bazel.lock") || cargoInputs.length > 0) {
		await $`bun scripts/gen-bazel-lock.ts`.env({ ...process.env, PATH: await bazeliskPath() });
		await $`git add MODULE.bazel.lock`;
	}
	return [...touched];
}

/** gen-bazel-lock needs `bazelisk` on PATH; without a global install, run the npm one. */
async function bazeliskPath(): Promise<string> {
	if (Bun.which("bazelisk") || Bun.which("bazel")) return process.env.PATH ?? "";
	const shimDir = fs.mkdtempSync(path.join(fs.realpathSync(Bun.env.TMPDIR ?? "/tmp"), "bazelisk-"));
	const shim = path.join(shimDir, "bazelisk");
	fs.writeFileSync(shim, '#!/bin/sh\nexec bunx --bun @bazel/bazelisk "$@"\n', { mode: 0o755 });
	return `${shimDir}:${process.env.PATH ?? ""}`;
}

/**
 * CHANGELOG.md merges by union, so a fork bullet that sat under `[Unreleased]`
 * lands silently inside the section upstream released in between.
 */
async function misplacedChangelogBullets(): Promise<string[]> {
	const misplaced: string[] = [];
	for (const file of new Bun.Glob("packages/*/CHANGELOG.md").scanSync({ cwd: REPO_ROOT })) {
		const upstream = await $`git show upstream/main:${file}`.nothrow().quiet();
		if (upstream.exitCode !== 0) continue;
		const upstreamBullets = new Set(releasedBullets(upstream.text()));
		for (const bullet of releasedBullets(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"))) {
			if (!upstreamBullets.has(bullet)) misplaced.push(`${file}: ${bullet.slice(0, 100)}`);
		}
	}
	return misplaced;
}

function releasedBullets(changelog: string): string[] {
	const firstRelease = changelog.search(/^## \[\d/m);
	if (firstRelease < 0) return [];
	return changelog
		.slice(firstRelease)
		.split("\n")
		.filter(line => line.startsWith("- "));
}

async function settleMerge(): Promise<void> {
	const deleted = await dropFilesDeletedByFork();
	const readded = await dropReaddedRemovedPaths();
	const locks = await regenerateLockfiles();
	for (const file of deleted) console.log(`dropped (deleted by fork): ${file}`);
	for (const entry of readded) console.log(`dropped (re-added under removed path): ${entry}`);
	for (const file of locks) console.log(`regenerated: ${file}`);

	const problems: string[] = [];
	const conflicts = await lines($`git diff --name-only --diff-filter=U`.quiet());
	for (const file of conflicts) problems.push(`conflict: ${file}`);
	for (const entry of presentRemovedPaths()) problems.push(`removed path exists: ${entry}`);
	for (const bullet of await misplacedChangelogBullets())
		problems.push(`changelog bullet outside [Unreleased]: ${bullet}`);
	if (problems.length > 0) {
		console.error("Merge left for manual resolution:");
		for (const problem of problems) console.error(`  ${problem}`);
		console.error("Resolve, `git add` the files, then run `bun scripts/sync-upstream.ts --continue`.");
		process.exit(1);
	}

	await $`git commit --no-edit`;
	console.log("Merged upstream/main. Next: `bun run check:ts` and the tests covering the merged areas.");
}

await configureGit();
if (!continueMerge) await mergeUpstream();
await settleMerge();

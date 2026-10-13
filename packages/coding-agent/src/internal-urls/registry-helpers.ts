/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";

const extraArtifactsDirs = new Set<string>();
/** Deepest nesting `sessionFilesFromDisk` descends below an artifacts dir. */
const MAX_SCAN_DEPTH = 8;

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects two candidate dirs per ref: the session manager's artifacts dir and
 * `sessionFile.slice(0, -6)`. `addDir` dedup collapses the case where both agree.
 *
 * When `options.preferredDir` is supplied — the caller root's canonical
 * artifact directory — it is inserted FIRST, ahead of every registry-derived
 * dir, so the caller's own root wins when the process-global registry holds a
 * different root's session. Absent a preferred dir, registry order is kept.
 */
export function artifactsDirsFromRegistry(options?: { preferredDir?: string }): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	if (options?.preferredDir) addDir(options.preferredDir);
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

/**
 * Recursively scan artifacts dirs for session transcripts, keyed by id (the
 * `.jsonl` basename). Used by `history://` so transcripts of sessions no
 * longer in the registry remain reachable. Advisor transcripts
 * (`__advisor*.jsonl`) are observability-only and excluded; EPERM-rewrite
 * backups (`.bak`) are skipped. When the same id appears in multiple dirs, the
 * first hit wins (registry dirs are scanned first; a `preferredDir` is scanned
 * before them). Directory listings are prefetched in parallel; the walk itself
 * stays a sequential depth-first pass so first-hit order is unaffected.
 */
export async function sessionFilesFromDisk(preferredDir?: string): Promise<Map<string, string>> {
	const dirs = preferredDir ? [preferredDir, ...artifactsDirsFromRegistry()] : artifactsDirsFromRegistry();
	const listings = new Map<string, Promise<Dirent[] | null>>();
	const list = (dir: string, depth: number): Promise<Dirent[] | null> => {
		let listing = listings.get(dir);
		if (listing) return listing;
		listing = readDirEntries(dir);
		listings.set(dir, listing);
		// Fan out to subdirectories as soon as this listing lands. Rejections
		// are surfaced (in walk order) by the awaiting scan below.
		listing.then(
			entries => {
				if (!entries || depth >= MAX_SCAN_DEPTH) return;
				for (const entry of entries) {
					if (entry.isDirectory()) list(path.join(dir, entry.name), depth + 1);
				}
			},
			() => {},
		);
		return listing;
	};
	for (const dir of dirs) list(dir, 0);

	const found = new Map<string, string>();
	const seenDirs = new Set<string>();
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		const entries = await list(dir, depth);
		if (!entries) return;
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (!name.endsWith(".jsonl")) continue;
			if (name.startsWith("__advisor")) continue;
			const id = name.slice(0, -".jsonl".length);
			if (!found.has(id)) found.set(id, path.join(dir, name));
		}
	};
	for (const dir of dirs) await scan(dir, 0);
	return found;
}

/** Directory entries of `dir`, or null when it is missing or not a directory. */
async function readDirEntries(dir: string): Promise<Dirent[] | null> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
		throw err;
	}
}

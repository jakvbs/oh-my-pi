import * as vcs from "@oh-my-pi/pi-natives/vcs";

export async function diffStats(cwd: string, baseRef: string, headRef: string) {
	if (!baseRef || !headRef || baseRef.startsWith("-") || headRef.startsWith("-")) {
		throw new Error("Provide two commit revisions: BASE HEAD.");
	}
	const repo = vcs.requireGit(cwd);
	const base = await repo.resolveRef(`${baseRef}^{commit}`);
	const head = await repo.resolveRef(`${headRef}^{commit}`);
	if (!base || !head) throw new Error(`Cannot resolve commit range ${baseRef}..${headRef}.`);
	const entries = await repo.numstat({ base, head });
	let added = 0;
	let removed = 0;
	let binaryFiles = 0;
	for (const entry of entries) {
		if (entry.added == null || entry.removed == null) {
			binaryFiles++;
		} else {
			added += entry.added;
			removed += entry.removed;
		}
	}
	return {
		comparison: "endpoint-trees",
		base: { ref: baseRef, commit: base },
		head: { ref: headRef, commit: head },
		files: entries.length,
		binaryFiles,
		added,
		removed,
		net: added - removed,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log(
			"Usage: bun run diff:stats BASE HEAD\nReports the difference between two commit trees, not a sum of commits. Counts all tracked text lines, including comments and generated files. Binary files are counted separately.",
		);
	} else {
		try {
			if (args.length !== 2) throw new Error("Usage: bun run diff:stats BASE HEAD");
			console.log(JSON.stringify(await diffStats(process.cwd(), args[0]!, args[1]!), null, 2));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}

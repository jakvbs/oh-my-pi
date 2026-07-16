import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	CommitVerificationError,
	type CommitVerificationRequest,
	commit,
	registerCommitVerifier,
} from "../src/utils/git";

const disposers: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

async function createRepository(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-verification-"));
	tempDirs.push(cwd);
	await $`git init -q`.cwd(cwd);
	await $`git config user.name "OMP Test"`.cwd(cwd);
	await $`git config user.email omp-test@example.invalid`.cwd(cwd);
	return cwd;
}

async function stageFile(cwd: string, content: string): Promise<void> {
	await Bun.write(path.join(cwd, "tracked.txt"), content);
	await $`git add tracked.txt`.cwd(cwd);
}

describe("Git commit verification", () => {
	it("rejects a commit without moving HEAD", async () => {
		const cwd = await createRepository();
		await stageFile(cwd, "rejected\n");
		disposers.push(registerCommitVerifier(async () => ({ allowed: false, reason: "judge rejected candidate" })));

		await expect(commit(cwd, "test: rejected")).rejects.toThrow(
			new CommitVerificationError("judge rejected candidate"),
		);
		expect((await $`git rev-parse --verify HEAD`.cwd(cwd).quiet().nothrow()).exitCode).not.toBe(0);
	});

	it("rejects when the candidate changes while verification is running", async () => {
		const cwd = await createRepository();
		await stageFile(cwd, "before review\n");
		disposers.push(
			registerCommitVerifier(async () => {
				await stageFile(cwd, "changed during review\n");
				return { allowed: true, reason: "accepted stale candidate" };
			}),
		);

		await expect(commit(cwd, "test: stale candidate")).rejects.toThrow(
			"Commit candidate changed during verification",
		);
		expect((await $`git rev-parse --verify HEAD`.cwd(cwd).quiet().nothrow()).exitCode).not.toBe(0);
	});

	it("passes amend intent and immutable diff evidence to the verifier", async () => {
		const cwd = await createRepository();
		await stageFile(cwd, "initial\n");
		await commit(cwd, "test: initial");
		await stageFile(cwd, "amended\n");
		let request: CommitVerificationRequest | undefined;
		disposers.push(
			registerCommitVerifier(async candidate => {
				request = candidate;
				return { allowed: true, reason: "accepted" };
			}),
		);

		await commit(cwd, "test: amended", { amend: true });

		expect(request?.options.amend).toBe(true);
		expect(request?.diff).toContain("+amended");
		expect((await $`git log -1 --format=%s`.cwd(cwd).text()).trim()).toBe("test: amended");
	});
});

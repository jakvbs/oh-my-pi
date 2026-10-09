import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	extractReviewPrRefFromArgs,
	liveCommandCwd,
	resolvePrReviewTarget,
	selectReviewChoice,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import {
	getReviewTargetIssue,
	resolveLocalReviewTarget,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/target";
import type { CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { PrDiffPayload, ViewLookupResult } from "@oh-my-pi/pi-coding-agent/tools/gh";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const SAMPLE_JJ_DIFF = `diff --git a/src/workspace.ts b/src/workspace.ts
--- a/src/workspace.ts
+++ b/src/workspace.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

const SAMPLE_PR_DIFF = `diff --git a/src/pr.ts b/src/pr.ts
--- a/src/pr.ts
+++ b/src/pr.ts
@@ -1 +1 @@
-export const pr = false;
+export const pr = true;
`;

interface SelectCall {
	title: string;
	options: string[];
}
interface NotifyCall {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

interface InputCall {
	title: string;
	placeholder: string | undefined;
}

interface StatusCall {
	key: string;
	text: string | undefined;
}

function makePrDiffLookup(unified: string): ViewLookupResult<PrDiffPayload> {
	return {
		rendered: unified,
		sourceUrl: undefined,
		payload: { unified, files: [] },
		status: "fresh",
		fetchedAt: Date.now(),
	};
}

function makeUserEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-05T00:00:00.000Z",
		message: {
			role: "user",
			content,
			timestamp: Date.now(),
		},
	};
}

describe("review target helpers", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-target-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await removeWithRetries(tmpDir);
	});

	function createContext(options?: {
		selectResults?: string[];
		inputResults?: Array<string | undefined>;
		sessionEntries?: SessionEntry[];
		branchEntries?: SessionEntry[];
		onSelectCall?: (call: SelectCall) => void;
		onInputCall?: (call: InputCall) => void;
		onStatusCall?: (call: StatusCall) => void;
		onNotify?: (call: NotifyCall) => void;
		cwd?: string;
	}): HookCommandContext {
		const selectResults = [...(options?.selectResults ?? [])];
		const inputResults = [...(options?.inputResults ?? [])];
		return {
			hasUI: true,
			sessionManager: {
				getEntries: () => options?.sessionEntries ?? [],
				getBranch: () => options?.branchEntries ?? options?.sessionEntries ?? [],
				getCwd: () => options?.cwd,
			},
			ui: {
				select: (title: string, selectOptions: string[]) => {
					options?.onSelectCall?.({ title, options: selectOptions });
					return Promise.resolve(selectResults.shift());
				},
				input: (title: string, placeholder?: string) => {
					options?.onInputCall?.({ title, placeholder });
					return Promise.resolve(inputResults.shift());
				},
				setStatus: (key: string, text: string | undefined) => {
					options?.onStatusCall?.({ key, text });
				},
				notify: (message: string, type?: "info" | "warning" | "error") => {
					options?.onNotify?.({ message, type });
				},
			},
		} as unknown as HookCommandContext;
	}

	async function menuOptions(ctx: HookCommandContext): Promise<string[]> {
		let options: string[] = [];
		const wrapped = {
			...ctx,
			ui: {
				...ctx.ui,
				select: (title: string, selectOptions: string[]) => {
					if (title === "Review Mode") options = selectOptions;
					return Promise.resolve(undefined);
				},
			},
		} as unknown as HookCommandContext;
		await selectReviewChoice(wrapped, tmpDir);
		return options;
	}

	it("reads JJ working-copy diffs for uncommitted targets", async () => {
		const jjDiffSpy = vi.fn(async () => SAMPLE_JJ_DIFF);
		spyOn(vcs, "require").mockReturnValue({
			kind: () => "jj",
			uncommittedDiff: jjDiffSpy,
		} as unknown as VcsRepo);
		const gitRepoSpy = spyOn(vcs, "requireGit");

		const target = await resolveLocalReviewTarget("uncommitted", tmpDir, createContext().ui);

		expect(target?.mode).toBe("Reviewing JJ working-copy changes");
		expect(target?.snapshot.files.map(file => file.path)).toEqual(["src/workspace.ts"]);
		expect(jjDiffSpy).toHaveBeenCalledWith([]);
		expect(gitRepoSpy).not.toHaveBeenCalled();
	});

	it("prefers the live session cwd over the load-time cwd (issue #12501)", () => {
		const staleDir = path.join(tmpDir, "stale-checkout");
		const liveDir = path.join(tmpDir, "live-worktree");
		const api = { cwd: staleDir } as unknown as CustomCommandAPI;

		expect(liveCommandCwd(api, createContext({ cwd: liveDir }))).toBe(liveDir);
		expect(liveCommandCwd(api, createContext())).toBe(staleDir);
	});

	it("parses supported explicit PR URL formats", () => {
		const cases = [
			"https://github.com/owner/repo/pull/123",
			"https://github.com/owner/repo/pull/123/",
			"https://github.com/owner/repo/pull/123?tab=files",
			"https://github.com/owner/repo/pull/123#discussion_r123",
			"https://github.com/owner/repo/pull/123/files",
			"https://github.com/owner/repo/pull/123/commits",
			"pr://owner/repo/123/diff/all",
			"pr://owner/repo/123/diff/1",
		];

		for (const url of cases) {
			const { prRef } = extractReviewPrRefFromArgs([url]);
			expect(prRef).toMatchObject({ repo: "owner/repo", number: 123 });
		}
	});

	it("keeps unsupported PR-like URL formats as instructions", () => {
		const cases = [
			"https://github.com/owner/repo/issues/123",
			"https://github.com/owner/repo/commit/abc123",
			"https://example.com/owner/repo/pull/123",
			"pr://123",
			"https://github.com/owner/repo/pull/0",
			"https://github.com/owner/repo/pull/-1",
			"https://github.com/owner/repo/pull/not-a-number",
		];

		for (const url of cases) {
			expect(extractReviewPrRefFromArgs([url])).toEqual({ prRef: undefined, extraInstructions: url });
		}
	});

	it("removes only the first valid PR URL from extra instructions", () => {
		const secondUrl = "https://github.com/owner/repo/pull/456";

		const parsed = extractReviewPrRefFromArgs(["focus", "https://github.com/owner/repo/pull/123", "on", secondUrl]);

		expect(parsed.prRef).toMatchObject({ repo: "owner/repo", number: 123 });
		expect(parsed.extraInstructions).toBe(`focus on ${secondUrl}`);
	});

	it("freezes a fetched PR diff as a review target", async () => {
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));

		const target = await resolvePrReviewTarget(tmpDir, createContext(), {
			repo: "owner/repo",
			number: 123,
			raw: "pr://owner/repo/123",
			kind: "pr-url",
		});

		expect(target?.mode).toBe("PR owner/repo#123");
		expect(target?.snapshot.files.map(file => file.path)).toEqual(["src/pr.ts"]);
		expect(diffSpy).toHaveBeenCalledWith({ cwd: tmpDir, repo: "owner/repo", number: 123 });
	});

	it("notifies and stops when PR diff fetching fails", async () => {
		spyOn(gh, "getOrFetchPrDiff").mockRejectedValue(new Error("authentication required"));
		const notifications: NotifyCall[] = [];
		const ctx = createContext({ onNotify: call => notifications.push(call) });

		const target = await resolvePrReviewTarget(tmpDir, ctx, {
			repo: "owner/repo",
			number: 123,
			raw: "pr://owner/repo/123",
			kind: "pr-url",
		});

		expect(target).toBeUndefined();
		expect(notifications).toEqual([
			{ message: "Failed to fetch PR diff for owner/repo#123: authentication required", type: "error" },
		]);
	});

	it("reports an empty PR diff as a target issue", async () => {
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(" \n"));

		const target = await resolvePrReviewTarget(tmpDir, createContext(), {
			repo: "owner/repo",
			number: 123,
			raw: "pr://owner/repo/123",
			kind: "pr-url",
		});

		expect(target && getReviewTargetIssue(target)).toBe("PR owner/repo#123 has no diff content available");
	});

	it("offers a detected PR from recent conversation context", async () => {
		const ctx = createContext({
			selectResults: ["Review PR owner/example#77 from conversation"],
			sessionEntries: [makeUserEntry("u1", "Please review https://github.com/owner/example/pull/77.")],
		});

		const choice = await selectReviewChoice(ctx, tmpDir);

		expect(choice).toMatchObject({ kind: "pr", ref: { repo: "owner/example", number: 77 } });
	});

	it("detects only PR URLs from the active branch path", async () => {
		const options = await menuOptions(
			createContext({
				sessionEntries: [
					makeUserEntry("stale", "Stale https://github.com/owner/example/pull/77"),
					makeUserEntry("active", "Active https://github.com/owner/example/pull/78"),
				],
				branchEntries: [makeUserEntry("active", "Active https://github.com/owner/example/pull/78")],
			}),
		);

		expect(options).toContain("Review PR owner/example#78 from conversation");
		expect(options).not.toContain("Review PR owner/example#77 from conversation");
	});

	it("deduplicates detected PR menu entries", async () => {
		const options = await menuOptions(
			createContext({
				sessionEntries: [
					makeUserEntry("u1", "Review https://github.com/owner/example/pull/77 and pr://owner/example/77/diff/1"),
				],
			}),
		);

		expect(options.filter(option => option === "Review PR owner/example#77 from conversation")).toHaveLength(1);
	});

	it("orders detected PR menu entries by most recent mention", async () => {
		const options = await menuOptions(
			createContext({
				sessionEntries: [
					makeUserEntry("u1", "Older https://github.com/owner/example/pull/77"),
					makeUserEntry("u2", "Newer https://github.com/owner/example/pull/78"),
				],
			}),
		);

		expect(options.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("orders detected PR menu entries by rightmost mention within one message", async () => {
		const options = await menuOptions(
			createContext({
				sessionEntries: [
					makeUserEntry(
						"u1",
						"Older https://github.com/owner/example/pull/77 newer https://github.com/owner/example/pull/78",
					),
				],
			}),
		);

		expect(options.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("shows only diff targets when no recent PR is detected", async () => {
		expect(await menuOptions(createContext())).toEqual([
			"1. Review against a base branch (PR Style)",
			"2. Review uncommitted changes",
			"3. Review a specific commit",
			"4. Review a specific PR",
		]);
	});

	it("resolves a PR picked from the open pull request list", async () => {
		spyOn(gh, "resolveDefaultRepoMemoized").mockResolvedValue("owner/repo");
		const listSpy = spyOn(github, "json").mockResolvedValue([
			{ number: 42, title: "Fix login", author: { login: "octocat" }, url: "https://github.com/owner/repo/pull/42" },
			{ number: 43, title: "WIP thing", author: { login: "hubot" }, isDraft: true },
		]);
		const ctx = createContext({ selectResults: ["4. Review a specific PR", "#42  Fix login  @octocat"] });

		const choice = await selectReviewChoice(ctx, tmpDir);

		expect(choice).toMatchObject({ kind: "pr", ref: { repo: "owner/repo", number: 42 } });
		expect(listSpy).toHaveBeenCalled();
	});

	it("searches open pull requests and resolves a filtered pick", async () => {
		spyOn(gh, "resolveDefaultRepoMemoized").mockResolvedValue("owner/repo");
		const fullList = [
			{ number: 42, title: "Fix login", author: { login: "octocat" } },
			{ number: 43, title: "Other work", author: { login: "hubot" } },
		];
		const filteredList = [{ number: 7, title: "Filtered match", author: { login: "octocat" } }];
		const listSpy = spyOn(github, "json").mockImplementation(async (_cwd: string, args: string[]) => {
			const searchIndex = args.indexOf("--search");
			return (searchIndex === -1 ? fullList : filteredList) as never;
		});
		const selectCalls: SelectCall[] = [];
		const ctx = createContext({
			selectResults: ["4. Review a specific PR", "Search open pull requests…", "#7  Filtered match  @octocat"],
			inputResults: ["match"],
			onSelectCall: call => selectCalls.push(call),
		});

		const choice = await selectReviewChoice(ctx, tmpDir);

		expect(choice).toMatchObject({ kind: "pr", ref: { repo: "owner/repo", number: 7 } });
		expect(
			listSpy.mock.calls.some(
				call => (call[1] as string[]).includes("--search") && (call[1] as string[]).includes("match"),
			),
		).toBe(true);
		const filteredSelect = selectCalls.find(
			call => call.title === 'Open pull requests in owner/repo matching "match"',
		);
		expect(filteredSelect?.options).toContain("#7  Filtered match  @octocat");
	});

	it("keeps the picker open when a search request fails", async () => {
		spyOn(gh, "resolveDefaultRepoMemoized").mockResolvedValue("owner/repo");
		spyOn(github, "json").mockImplementation(async (_cwd: string, args: string[]) => {
			if (args.includes("--search")) throw new Error("gh: rate limited");
			return [{ number: 42, title: "Fix login", author: { login: "octocat" } }] as never;
		});
		const notifications: NotifyCall[] = [];
		const ctx = createContext({
			selectResults: ["4. Review a specific PR", "Search open pull requests…", "#42  Fix login  @octocat"],
			inputResults: ["login"],
			onNotify: call => notifications.push(call),
		});

		const choice = await selectReviewChoice(ctx, tmpDir);

		expect(notifications).toContainEqual({
			message: "Failed to list open pull requests in owner/repo: gh: rate limited",
			type: "error",
		});
		expect(choice).toMatchObject({ kind: "pr", ref: { repo: "owner/repo", number: 42 } });
	});

	it("resolves a numeric search query directly without a search request", async () => {
		spyOn(gh, "resolveDefaultRepoMemoized").mockResolvedValue("owner/repo");
		const listSpy = spyOn(github, "json").mockResolvedValue([
			{ number: 42, title: "Fix login", author: { login: "octocat" } },
		]);
		const ctx = createContext({
			selectResults: ["4. Review a specific PR", "Search open pull requests…"],
			inputResults: ["#123"],
		});

		const choice = await selectReviewChoice(ctx, tmpDir);

		expect(choice).toMatchObject({ kind: "pr", ref: { repo: "owner/repo", number: 123 } });
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(listSpy.mock.calls.every(call => !(call[1] as string[]).includes("--search"))).toBe(true);
	});

	it("resolves base-branch targets against a real repo without a range revspec", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-real-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();

			// Same branch selected as base: must report no changes, not crash on
			// a `main...main` revspec that rev_parse_single cannot resolve.
			const sameTarget = await resolveLocalReviewTarget(
				"base-branch",
				dir,
				createContext({ selectResults: ["main"] }).ui,
			);
			expect(sameTarget && getReviewTargetIssue(sameTarget)).toBe("No changes between main and main");

			// Feature branch changes a.txt; main independently advances with a
			// base-only file. PR-style (merge-base) review must show only the
			// feature change, never main's base-only file. A two-tree
			// (`base head`) diff would surface base-only.txt as a reverse
			// deletion — the regression this asserts against.
			await $`git checkout -q -b feature`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "two\n");
			await $`git commit -q -am feature-change`.cwd(dir).quiet();
			await $`git checkout -q main`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "base-only.txt"), "base\n");
			await $`git add base-only.txt`.cwd(dir).quiet();
			await $`git commit -q -m base-advance`.cwd(dir).quiet();
			await $`git checkout -q feature`.cwd(dir).quiet();
			const featureTarget = await resolveLocalReviewTarget(
				"base-branch",
				dir,
				createContext({ selectResults: ["main"] }).ui,
			);
			expect(featureTarget?.mode).toBe("Reviewing changes between `main` and `feature` (PR-style)");
			expect(featureTarget?.snapshot.files.map(file => file.path)).toEqual(["a.txt"]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("rejects base-branch targets when histories share no merge base", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-orphan-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();
			await $`git config user.name Test`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "a.txt"), "one\n");
			await $`git add a.txt`.cwd(dir).quiet();
			await $`git commit -q -m init`.cwd(dir).quiet();

			// Orphan branch: no common ancestor with main, so PR-style review
			// must abort instead of comparing the two unrelated trees.
			await $`git checkout -q --orphan orphan`.cwd(dir).quiet();
			await $`git rm -q -rf .`.cwd(dir).quiet();
			await fs.writeFile(path.join(dir, "b.txt"), "other\n");
			await $`git add b.txt`.cwd(dir).quiet();
			await $`git commit -q -m orphan`.cwd(dir).quiet();

			const notices: NotifyCall[] = [];
			const target = await resolveLocalReviewTarget(
				"base-branch",
				dir,
				createContext({ selectResults: ["main"], onNotify: call => notices.push(call) }).ui,
			);
			expect(target).toBeUndefined();
			expect(notices).toEqual([{ message: "No common history between main and orphan", type: "error" }]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("resolves a specific commit target", async () => {
		const showSpy = vi.fn(async () => ({ data: Buffer.from(SAMPLE_PR_DIFF), truncated: false }));
		spyOn(vcs, "require").mockReturnValue({
			logOnelines: async () => ["abc1234 Fix review command"],
		} as unknown as VcsRepo);
		spyOn(vcs, "requireGit").mockReturnValue({
			showCommit: showSpy,
		} as unknown as VcsGitRepo);

		const target = await resolveLocalReviewTarget(
			"commit",
			tmpDir,
			createContext({ selectResults: ["abc1234 Fix review command"] }).ui,
		);

		expect(target?.mode).toBe("Reviewing commit `abc1234`");
		expect(target?.snapshot.files.map(file => file.path)).toEqual(["src/pr.ts"]);
		expect(showSpy).toHaveBeenCalledWith("abc1234");
	});
});

/**
 * Worktree settings (see `config/registry.ts`) shared by `/wt`, `omp worktree`, the `github`
 * `pr_checkout` op and `git worktree add` in bash. `config/all-settings.ts` registers every domain.
 */
import * as natives from "@oh-my-pi/pi-natives";
import { logger, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { effect, register, type SettingValueOf } from "../config/registry";

const { IsoBackendKind } = natives;
type IsoBackendKind = natives.IsoBackendKind;

export const cfgIsolationBackend = register({
	id: "isolation.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"] as const,
	default: "auto",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Isolation Backend",
		description: "Backend used for worktree cloning",
		options: [
			{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
			{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
			{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
			{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
			{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
			{
				value: "overlayfs",
				label: "Overlayfs",
				description: "Linux kernel overlay (or fuse-overlayfs fallback)",
			},
			{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
			{
				value: "block-clone",
				label: "Block clone",
				description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
			},
			{
				value: "rcopy",
				label: "Recursive copy",
				description: "git worktree if available, otherwise recursive copy",
			},
		],
	},
});

export const cfgWorktreeClone = register({
	id: "worktree.clone",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Clone Checkout into Worktrees",
		description:
			"New worktrees from `github pr_checkout` and `git worktree add` in bash start as a copy-on-write clone of the current checkout so ignored build artifacts (node_modules, target) carry over; falls back to a plain checkout when the filesystem cannot clone",
	},
});

export const cfgWorktreeCleanSource = register({
	id: "worktree.cleanSource",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Clean Source Checkout on /wt",
		description:
			"When creating a worktree with `/wt`, reset tracked changes and remove untracked files from the original checkout after carrying them over",
	},
});

export const cfgWorktreeOnStart = register({
	id: "worktree.onStart",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "ask", "create"] as const,
	default: "off",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Worktree on Start",
		description: "Whether fresh interactive sessions start in a new linked worktree",
		options: [
			{ value: "off", label: "Off", description: "Start in the current checkout" },
			{ value: "ask", label: "Ask", description: "Ask at session start" },
			{ value: "create", label: "Create", description: "Always start in a new worktree on a `wt/*` branch" },
		],
	},
});

export const cfgWorktreeOnExit = register({
	id: "worktree.onExit",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["keep", "ask", "remove"] as const,
	default: "keep",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Worktree on Exit",
		description: "What to do on exit with worktrees created since omp started (on start or with `/wt`)",
		options: [
			{ value: "keep", label: "Keep", description: "Leave worktrees in place" },
			{ value: "ask", label: "Ask", description: "Ask on exit" },
			{
				value: "remove",
				label: "Remove",
				description:
					"Remove clean worktrees; ask when they have uncommitted changes or new commits. Gitignored files (e.g. `.env`) are deleted too",
			},
		],
	},
});

export const cfgWorktreeBase = register({
	id: "worktree.base",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Worktree Base Directory",
		description:
			"Base directory for agent-managed worktrees — `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this.",
	},
});
effect(cfgWorktreeBase, value => {
	const dir = value?.trim() ? value : undefined;
	// Always applied, so an unset/empty value clears a previous override. setWorktreesDir expands `~`,
	// rejects relative paths, and returns the applied absolute path (undefined when cleared/rejected).
	if (!setWorktreesDir(dir) && dir) {
		logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
	}
});

/** User-facing backend names exposed by the `isolation.backend` setting. */
export type IsolationBackendSetting = SettingValueOf<typeof cfgIsolationBackend>;

/**
 * Translate an {@link IsolationBackendSetting} to the native backend hint.
 * `"auto"` returns `undefined`, allowing the PAL resolver to pick.
 */
export function parseIsolationBackend(backend: IsolationBackendSetting): IsoBackendKind | undefined {
	switch (backend) {
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
			return IsoBackendKind.Overlayfs;
		case "projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
			return IsoBackendKind.Rcopy;
	}
}

/** Return the canonical setting label for a resolved native backend. */
export function formatIsolationBackend(backend: IsoBackendKind): Exclude<IsolationBackendSetting, "auto"> {
	switch (backend) {
		case IsoBackendKind.Apfs:
			return "apfs";
		case IsoBackendKind.Btrfs:
			return "btrfs";
		case IsoBackendKind.Zfs:
			return "zfs";
		case IsoBackendKind.LinuxReflink:
			return "reflink";
		case IsoBackendKind.Overlayfs:
			return "overlayfs";
		case IsoBackendKind.Projfs:
			return "projfs";
		case IsoBackendKind.WindowsBlockClone:
			return "block-clone";
		case IsoBackendKind.Rcopy:
			return "rcopy";
	}
}

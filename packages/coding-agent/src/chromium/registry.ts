import { isCompiledBinary, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError } from "../tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { gracefulKillTreeOnce } from "./attach";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	connectPuppeteer,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import { reapOrphanSharedTargets } from "./orphan-registry";
import { ensureSharedBrowser } from "./shared-daemon";

/** Headless Chromium used by web-search fallbacks and PDF page rendering. */
export interface BrowserKind {
	kind: "headless";
	headless: boolean;
}

/**
 * Upper bound on `browser.close()` for headless Chromium. Puppeteer waits for
 * the process to fully exit; a wedged Chromium would otherwise hang cleanup
 * forever (issue #5260), so we cap the wait and force-kill on timeout.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;

export interface BrowserHandle {
	key: string;
	kind: BrowserKind;
	refCount: number;
	browser: Browser;
	/** OMP-owned temp Chromium profile directory removed on dispose (process-local headless launches). */
	userDataDir?: string;
	/** Broker daemon backing this handle; dispose disconnects instead of closing. */
	sharedDaemon?: { name: string; projectDir: string };
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

const browsers = new Map<string, BrowserHandle>();
/** In-flight opens by browser key, so concurrent acquisitions share one launch instead of storming Chromium. */
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

export function browserKey(kind: BrowserKind): string {
	return `headless:${kind.headless ? "1" : "0"}`;
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if (existing.browser.connected) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing);
			continue;
		}
		// Short-circuit before launching: the tool wrapper's `untilAborted` only
		// rejects its outer promise on abort; without this check `openBrowserHandle`
		// would still fire and its result would land in `browsers` below.
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

		// Single-flight per key: a concurrent caller already opening this browser
		// wins; everyone else waits and re-reads the registry. Without this, N
		// simultaneous opens each launch a Chromium and the last write wins,
		// leaking the rest as unreferenced process trees.
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		// The launch may resolve AFTER the caller has already aborted (the outer
		// `untilAborted` rejects immediately on abort but does not cancel the
		// inner promise, and `launchHeadlessBrowser` does not accept a signal).
		// Without this branch the completed handle sits in `browsers` at
		// refCount:0 forever — no tab ever takes a hold, `releaseBrowser` never
		// fires, and `releaseAllTabs` walks `tabs`, not `browsers`, so the
		// orphaned Chromium/app process / puppeteer handle survives to process
		// exit. (Issue #3963.)
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle).catch(err => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		return handle;
	}
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	// Every real omp process (session, subagent, worker — anything with a CLI
	// worker host) MUST go through the project-shared broker-owned Chromium:
	// per-process launches are what produced launch storms and orphaned
	// process trees. The process-local launch survives only for hosts that
	// cannot spawn the broker (bun test, SDK embedding without a CLI entry).
	if (isCompiledBinary() || workerHostEntry() !== null) {
		return await openSharedHeadlessHandle(kind, opts);
	}
	const { browser, userDataDir } = await launchHeadlessBrowser({ headless: kind.headless, viewport: opts.viewport });
	return {
		key: browserKey(kind),
		kind,
		browser,
		userDataDir,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle): Promise<void> {
	if (handle.sharedDaemon) {
		// The broker owns the Chromium; this process only drops its CDP
		// connection. Stopping the shared daemon here would tear down every other session's tabs. The
		// daemon dies with the last omp client in the project (broker idle
		// teardown), when its CDP endpoint stops answering after a failed tab
		// cleanup (`stopSharedBrowserIfUnreachable`), or via an explicit stop
		// (`write proc://<name>/kill`).
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from shared browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		// Puppeteer's `browser.close()` resolves only once the Chromium
		// process fully exits. A wedged Chromium (a known Windows failure
		// mode) leaves this await pending forever, freezing cleanup
		// (issue #5260). Bound it, then SIGKILL the
		// process tree so cleanup always completes.
		const proc = handle.browser.process();
		try {
			await withTimeout(handle.browser.close(), HEADLESS_CLOSE_TIMEOUT_MS, "Timed out closing headless browser");
		} catch (err) {
			logger.debug("Failed to close headless browser; force-killing", { error: (err as Error).message });
			if (proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid).catch(() => undefined);
		}
	}
	// OMP owns the profile directory (puppeteer's temp cleanup is disabled by
	// our explicit --user-data-dir), so remove it now the process tree has
	// exited. Tolerant of the Windows lock-held window (issue #7058).
	if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
}

/**
 * Attach to the project-shared broker-owned Chromium. Failures surface as
 * `ToolError` — a CLI-host process never silently falls back to a private
 * Chromium, so a broken broker cannot quietly recreate per-process launch
 * storms.
 */
async function openSharedHeadlessHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Shared browser daemon unavailable (broker start or Chromium launch failed); check `omp ps` for omp.browser.* daemons and ~/.omp/logs for details",
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
			browserWSEndpoint: shared.wsEndpoint,
			defaultViewport: kind.headless
				? {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
					}
				: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		// Attaching to the shared daemon is the natural point to sweep targets
		// left behind by omp processes that died without teardown — bounds
		// accumulation without a background timer. Best-effort and detached so a
		// slow reap never delays the open (issue #10022).
		void reapOrphanSharedTargets(browser, { projectDir: shared.projectDir, daemonName: shared.daemonName });
		return {
			key: browserKey(kind),
			kind,
			browser,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Shared browser attach failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}

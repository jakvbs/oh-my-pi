import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Frame, Page } from "puppeteer-core";
import type { BrowserHandle } from "../chromium/registry";
import type { ToolSession } from "../sdk";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_PAGE_MEMBER_RE = /^(?:p|page[-_]?)(\d+)(?:[-_].*)?\.png$/i;
const PDF_RENDER_TIMEOUT_MS = 30_000;
/** Bounds `page.close()`; a dead CDP session otherwise leaves it pending forever. */
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

/** A legacy PDF image-member path interpreted as a page screenshot request. */
export interface PdfImageReadTarget {
	/** PDF path before the member delimiter. */
	pdfPath: string;
	/** Original member text after the delimiter. */
	member: string;
	/** One-indexed page inferred from names such as `p2-img0.png`; defaults to page 1. */
	page: number;
}

/** Parse a former PDF image-member path as a Chromium page screenshot request. */
export function splitPdfImageReadPath(readPath: string): PdfImageReadTarget | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	const pdfPath = match?.[1];
	const member = match?.[2];
	if (!pdfPath || member === undefined) return null;
	const pageText = PDF_PAGE_MEMBER_RE.exec(member)?.[1];
	const parsedPage = pageText === undefined ? 1 : Number(pageText);
	const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
	return { pdfPath, member, page };
}

/** A rendered PDF page saved as a PNG file. */
export interface PdfPageScreenshot {
	dest: string;
	mimeType: "image/png";
}

/**
 * Chromium's PDF plugin paints in an out-of-process frame after navigation has
 * completed. Wait for document dimensions, then cross compositor boundaries
 * before capturing; otherwise the screenshot can contain only the viewer shell.
 */
const PDF_VIEWER_READY_EXPRESSION = `(() => {
	const viewer = document.querySelector("pdf-viewer");
	const toolbar = viewer?.shadowRoot?.querySelector("viewer-toolbar");
	const pageLength = toolbar?.shadowRoot
		?.querySelector("viewer-page-selector")
		?.shadowRoot?.querySelector("#pagelength")?.textContent;
	if (Number(pageLength) > 0 && !toolbar?.hasAttribute("loading_")) return true;
	const plugin = document.querySelector('embed[type="application/x-google-chrome-pdf"]');
	const sizer = document.querySelector("#sizer");
	return plugin !== null && sizer !== null && sizer.clientWidth > 0 && sizer.clientHeight > 0;
})()`;

const FOUR_ANIMATION_FRAMES_EXPRESSION = `new Promise(resolve =>
	requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
)`;

async function waitForPdfViewer(page: Page, signal: AbortSignal): Promise<Frame> {
	for (;;) {
		signal.throwIfAborted();
		for (const frame of page.frames()) {
			const loaded = await frame.evaluate(PDF_VIEWER_READY_EXPRESSION).catch(() => false);
			if (loaded) return frame;
		}
		await Bun.sleep(100);
	}
}

/** Render one PDF page through the shared headless Chromium. */
export async function renderPdfPageScreenshot(
	session: ToolSession,
	absolutePdfPath: string,
	page: number,
	signal?: AbortSignal,
): Promise<PdfPageScreenshot> {
	const { acquireBrowser, holdBrowser, releaseBrowser } = await import("../chromium/registry");
	const timeoutSignal = AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS);
	const renderSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const url = pathToFileURL(absolutePdfPath);
	url.hash = `page=${page}&toolbar=0&navpanes=0&view=Fit`;

	let browser: BrowserHandle | undefined;
	let tab: Page | undefined;
	try {
		const acquired = await untilAborted(renderSignal, () =>
			acquireBrowser({ kind: "headless", headless: true }, { cwd: session.cwd, signal: renderSignal }),
		);
		browser = acquired;
		holdBrowser(acquired);
		const activeTab = await untilAborted(renderSignal, () => acquired.browser.newPage());
		tab = activeTab;
		await untilAborted(renderSignal, () =>
			activeTab.goto(url.href, { waitUntil: "load", timeout: PDF_RENDER_TIMEOUT_MS }),
		);
		const viewerFrame = await waitForPdfViewer(activeTab, renderSignal);
		await untilAborted(renderSignal, () => activeTab.screenshot({ type: "png" }));
		await untilAborted(renderSignal, () => viewerFrame.evaluate(FOUR_ANIMATION_FRAMES_EXPRESSION));
		const png = await untilAborted(renderSignal, () => activeTab.screenshot({ type: "png", fullPage: true }));
		const dest = path.join(os.tmpdir(), `omp-pdf-page-${Bun.randomUUIDv7()}.png`);
		await Bun.write(dest, png);
		return { dest, mimeType: "image/png" };
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`Timed out rendering PDF page ${page} in Chromium.`);
		}
		throw error;
	} finally {
		if (tab) {
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), () => tab!.close()).catch(() => undefined);
		}
		if (browser) await releaseBrowser(browser);
	}
}

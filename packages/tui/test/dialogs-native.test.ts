import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings, type Component, type TerminalFrameProvider, type TUI } from "@oh-my-pi/pi-tui";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { AskDialogComponent, type ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\n";
const DOWN = "\x1b[B";

/** A terminal that draws every kind (`meter` included). */
const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search over described nodes, with the keypath the reconciler reports (hoisted overlays get `^`). */
function find(
	root: NativeNode,
	predicate: (node: NativeNode) => boolean,
	path = "",
): { node: NativeNode; path: string } | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const segment = child.k === "overlay" ? `^${child.key ?? index}` : `${child.key ?? index}`;
		const childPath = path ? `${path}/${segment}` : segment;
		if (predicate(child)) return { node: child, path: childPath };
		const found = find(child, predicate, childPath);
		if (found) return found;
	}
	return undefined;
}

const QUESTIONS: ExtensionAskDialogQuestion[] = [
	{
		id: "policy",
		question: "How should frames without credits be handled?",
		options: [{ label: "Drop them" }, { label: "Park them" }, { label: "Block" }],
		recommended: 1,
	},
	{ id: "flag", question: "Ship behind a flag?", options: [{ label: "Yes" }, { label: "No" }] },
];

function ask(onSubmit = vi.fn(), onCancel = vi.fn()): AskDialogComponent {
	return new AskDialogComponent(QUESTIONS, { onSubmit, onCancel, onPrompt: async () => undefined });
}

describe("dialogs under a native surface", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("ask: the action bar's Submit answers exactly as Enter does, question by question", () => {
		const viaKeys = vi.fn();
		const keyed = ask(viaKeys);
		keyed.handleInput(ENTER);
		keyed.handleInput(DOWN);
		keyed.handleInput(ENTER);
		keyed.handleInput(ENTER);

		const viaPointer = vi.fn();
		const pointed = ask(viaPointer);
		const press = (act: string) => {
			const button = find(pointed.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
			if (!button) throw new Error(`no ${act} button`);
			pointed.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
		};
		press("submit");
		pointed.handleInput(DOWN);
		press("submit");
		// Review tab: Submit sends the answers.
		press("submit");

		expect(viaKeys).toHaveBeenCalledTimes(1);
		expect(viaPointer.mock.calls).toEqual(viaKeys.mock.calls);
		expect(
			viaPointer.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions),
		).toEqual([["Park them"], ["No"]]);
	});

	it("ask: tab and option events reach the dialog through its described keypaths", () => {
		const onSubmit = vi.fn();
		const dialog = ask(onSubmit);
		const tabs = find(dialog.describe(CX), node => node.k === "tabs");
		dialog.handleNativeEvent({ type: "select", key: tabs!.path, item: "1" });
		const options = find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		expect(options?.node.key).toBe("q1");
		dialog.handleNativeEvent({ type: "activate", key: options!.path, item: "option:0" });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(onSubmit.mock.calls[0]?.[0].results[1].selectedOptions).toEqual(["Yes"]);
	});

	it("ask: docks in place of the composer instead of a modal sheet over the transcript", async () => {
		// A modal bottom sheet hid the transcript rows explaining the question and blocked scrolling.
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this decision") };
		const dialog = ask();
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [dialog] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			expect(harness.region("layer")?.c ?? []).toEqual([]);
			const dock = harness.region("dock")!;
			// Framed as the prompt composer (its root role), so Tern spaces it the same way.
			const root = dock.c?.find(node => node.p?.role === "omp.editor");
			expect(root?.c?.some(node => node.p?.role === "omp.ask.options")).toBe(true);
			expect(harness.findAll(node => node.k === "overlay")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("ask: Skip cancels like Esc; the recommended option loses its suffix for the badge", () => {
		const onCancel = vi.fn();
		const dialog = ask(vi.fn(), onCancel);
		const recommended = find(dialog.describe(CX), node => node.k === "item" && node.key === "option:1");
		expect(recommended?.node.p).toMatchObject({ label: [{ t: "Park them" }], value: [{ t: "Recommended" }] });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("login: Cancel runs Esc's path and Continue submits the pasted code", async () => {
		const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
		const onComplete = vi.fn();
		const dialog = new LoginDialogComponent(tui, "openai-codex", onComplete, () => {});
		dialog.showAuth("https://auth.example.com/authorize?x=1", "Enter code: ABCD-1234");
		const pending = dialog.showManualInput("Paste the authorization code:");
		const described = dialog.describe();
		expect(find(described, node => node.p?.role === "omp.login.code")?.node.p).toMatchObject({
			spans: [{ t: "ABCD-1234", s: "mono" }],
		});
		dialog.pasteText("code-123");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(await pending).toBe("code-123");

		const cancelled = dialog.showManualInput("Paste the authorization code:");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		await expect(cancelled).rejects.toThrow("Login cancelled");
		expect(onComplete).toHaveBeenCalledWith(false, "Login cancelled");
	});
});

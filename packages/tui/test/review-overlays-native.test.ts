import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CodeReviewOverlayResult, ReviewDiffFile } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

const ENTER = "\r";

let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search for the described node with sibling key `key`, returning it with its keypath. */
function findKeyed(root: NativeNode, key: string, path = ""): { node: NativeNode; path: string } | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const childPath = path ? `${path}/${child.key ?? index}` : `${child.key ?? index}`;
		if (child.key === key) return { node: child, path: childPath };
		const found = findKeyed(child, key, childPath);
		if (found) return found;
	}
	return undefined;
}

function list(root: NativeNode, key: string): { path: string; items: NativeNode[]; selected: unknown } {
	const found = findKeyed(root, key);
	if (!found || found.node.k !== "list") throw new Error(`no list ${key}`);
	return {
		path: found.path,
		items: (found.node.c ?? []).filter(isNode),
		selected: found.node.p?.selected,
	};
}

function itemLabel(node: NativeNode): string {
	if (node.k !== "item") return "";
	const label = node.p?.label ?? "";
	return typeof label === "string" ? label : label.map(s => s.t).join("");
}

describe("review overlays under a native surface", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("code review: selecting a diff row anchors the next line note to it", () => {
		const hunkHeader = "@@ -1,2 +1,2 @@";
		const file: ReviewDiffFile = {
			path: "src/a.ts",
			occurrence: 1,
			rawDiff: "",
			rows: [
				{ kind: "hunk", raw: hunkHeader, hunkHeader },
				{ kind: "context", raw: " keep", content: "keep", oldLine: 1, newLine: 1, hunkHeader },
				{ kind: "removed", raw: "-gone", content: "gone", oldLine: 2, hunkHeader },
			],
			linesAdded: 0,
			linesRemoved: 1,
			isBinary: false,
		};
		let result: CodeReviewOverlayResult | undefined;
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[file],
			"Reviewing",
			{ onComplete: r => (result = r) },
		);
		const lines = list(overlay.describe(), "lines");
		const removed = lines.items.find(node => itemLabel(node).includes("gone"))!;
		overlay.handleNativeEvent({ type: "select", key: lines.path, item: removed.key! });
		expect(list(overlay.describe(), "lines").selected).toBe(removed.key);

		overlay.handleInput("a");
		overlay.handleInput("why remove");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({ scope: "line", oldLine: 2, rawLine: "-gone", note: "why remove" }),
		]);

		// Paste is enabled once a note exists; activating it finishes with the notes.
		const actions = list(overlay.describe(), "actions");
		overlay.handleNativeEvent({ type: "activate", key: actions.path, item: actions.items[0]!.key! });
		expect(result).toEqual({ action: "paste", annotations: overlay.getAnnotations() });
	});

	it("code review: pages native diff selection by logical source rows", () => {
		const hunkHeader = "@@ -1,6 +1,6 @@";
		const sourceRows: ReviewDiffFile["rows"] = Array.from(
			{ length: 6 },
			(_, index): ReviewDiffFile["rows"][number] => {
				const number = index + 1;
				const content = `NATIVE_ROW_${number}`;
				return { kind: "added", raw: `+${content}`, content, newLine: number, hunkHeader };
			},
		);
		const file: ReviewDiffFile = {
			path: "src/native.ts",
			occurrence: 1,
			rawDiff: "",
			rows: [{ kind: "hunk", raw: hunkHeader, hunkHeader }, ...sourceRows],
			linesAdded: sourceRows.length,
			linesRemoved: 0,
			isBinary: false,
		};
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 12 }, requestRender() {}, nativeRendering: true } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[file],
			"Reviewing",
			{ onComplete: () => {} },
		);

		overlay.describe();
		overlay.handleInput("\t");
		overlay.handleInput("\x1b[6~");
		expect(list(overlay.describe(), "lines").selected).toBe("l2");
		overlay.handleInput("\x1b[5~");
		expect(list(overlay.describe(), "lines").selected).toBe("l0");
		overlay.handleInput("G");
		expect(list(overlay.describe(), "lines").selected).toBe("l5");
		overlay.handleInput("g");
		expect(list(overlay.describe(), "lines").selected).toBe("l0");
	});
	it("code review: a disabled paste action ignores activation", () => {
		const onComplete = vi.fn();
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[],
			"Reviewing",
			{ onComplete },
		);
		const actions = list(overlay.describe(), "actions");
		expect(actions.items[0]?.p).toMatchObject({ disabled: true });
		overlay.handleNativeEvent({ type: "activate", key: actions.path, item: actions.items[0]!.key! });
		expect(onComplete).not.toHaveBeenCalled();
	});
});

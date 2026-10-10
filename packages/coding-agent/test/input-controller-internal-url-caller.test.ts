import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

test("internal URL suggestions follow the receiving session when focus changes within one cwd", async () => {
	InternalUrlRouter.resetForTests();
	InternalUrlRouter.instance().register({
		scheme: "callerfixture",
		spec: { backing: "virtual", selectors: "none", immutable: true },
		async resolve() {
			throw new Error("Completion fixture cannot be read.");
		},
		async complete(_query, context) {
			return [{ value: path.basename(context?.sessionFile ?? "missing-caller"), description: context?.cwd }];
		},
	});
	const cwd = process.cwd();
	const main = createInteractiveModeContext({
		settings: Settings.isolated(),
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "main-session",
			getSessionFile: () => "/tmp/main-session.jsonl",
		},
	});
	const child = createInteractiveModeContext({
		settings: Settings.isolated(),
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "child-session",
			getSessionFile: () => "/tmp/child-session.jsonl",
		},
	});
	let receivingSession = main.session;
	Object.defineProperty(main, "viewSession", { get: () => receivingSession });
	const provider = new InputController(main).createAutocompleteProvider([], cwd);
	const line = "read callerfixture://";
	const forMain = await provider.getSuggestions([line], 0, line.length);
	expect(forMain?.items.map(item => [item.value, item.description])).toEqual([
		["callerfixture://main-session.jsonl", cwd],
	]);
	receivingSession = child.session;
	const forChild = await provider.getSuggestions([line], 0, line.length);
	expect(forChild?.items.map(item => [item.value, item.description])).toEqual([
		["callerfixture://child-session.jsonl", cwd],
	]);
});

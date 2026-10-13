import { beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

interface NewSessionHarness {
	ctx: InteractiveModeContext;
	controller: CommandController;
	counts: {
		newSession: () => number;
		resetTranscriptAnchors: () => number;
		resetTranscript: () => number;
		presented: () => number;
	};
}

function makeHarness(): NewSessionHarness {
	let newSession = 0;
	let resetTranscriptAnchors = 0;
	let resetTranscript = 0;
	let presented = 0;

	const ctx = {
		session: {
			isCompacting: false,
			newSession: async () => {
				newSession++;
				return true;
			},
		},
		sessionManager: {
			getSessionName: () => undefined,
			getCwd: () => "/tmp",
		},
		eventController: {
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		updateEditorBorderColor: () => {},
		clearTransientSessionUi: () => {},
		resetTranscript: () => {
			resetTranscript++;
		},
		present: () => {
			presented++;
		},
		reloadTodos: async () => {},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		controller: new CommandController(ctx),
		counts: {
			newSession: () => newSession,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			resetTranscript: () => resetTranscript,
			presented: () => presented,
		},
	};
}

describe("CommandController new-session teardown", () => {
	it("purges transcript anchors on /new", async () => {
		const harness = makeHarness();

		await harness.controller.handleClearCommand();

		expect(harness.counts.newSession()).toBe(1);
		expect(harness.counts.resetTranscriptAnchors()).toBe(1);
		expect(harness.counts.resetTranscript()).toBe(1);
		expect(harness.counts.presented()).toBe(1);
	});
});

import { describe, expect, expectTypeOf, it } from "bun:test";
import {
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	runSessionToYield,
	type SessionYieldOutcome,
	SessionManager,
	Settings,
	YieldTool,
} from "@oh-my-pi/pi-coding-agent";

describe("SDK embedder surface", () => {
	it("exports the entry points an embedder drives a structured session with, from the package root", () => {
		expect([createAgentSession, discoverAuthStorage, runSessionToYield].map(entry => typeof entry)).toEqual([
			"function",
			"function",
			"function",
		]);
		expect([ModelRegistry, SessionManager, Settings, YieldTool].map(entry => typeof entry)).toEqual([
			"function",
			"function",
			"function",
			"function",
		]);
		// Embedders switch exhaustively over the outcome; a sixth kind would break their build.
		expectTypeOf<SessionYieldOutcome["kind"]>().toEqualTypeOf<
			"yielded" | "provider-error" | "aborted" | "no-yield" | "schema-violation"
		>();
	});
});

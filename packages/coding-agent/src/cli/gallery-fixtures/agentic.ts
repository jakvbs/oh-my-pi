// Gallery fixtures for agentic orchestration (wait, goal, yield).
import type { YieldItem } from "@oh-my-pi/pi-tui/tools/yield";
import type { GalleryFixture } from "./types";

/** A structured result, as `yield` submits it. */
const YIELD_DATA = {
	summary: "Two races in the session store's flush path.\nBoth need the store lock held across the read.",
	confidence: 0.85,
	findings: [
		{ file: "src/session/store.ts", line: 142, issue: "flush() reads entries without holding the lock" },
		{ file: "src/session/store.ts", line: 188, issue: "concurrent flushes can write the same batch twice" },
	],
};

export const agenticFixtures: Record<string, GalleryFixture> = {
	goal: {
		label: "Goal",
		// Streaming: op is "create"; objective text still being typed.
		streamingArgs: { op: "create", objective: "Ship the auth hardening" },
		args: {
			op: "create",
			objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
			token_budget: 500_000,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Goal set. Working toward: Ship the auth hardening pass.",
				},
			],
			details: {
				op: "create",
				remainingTokens: 451_800,
				completionBudgetReport: null,
				goal: {
					id: "goal_8f2a",
					objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
					status: "active",
					tokenBudget: 500_000,
					tokensUsed: 48_200,
					timeUsedSeconds: 312,
					createdAt: 1_749_200_000_000,
					updatedAt: 1_749_200_312_000,
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Goal tool failed: objective is required when op=create." }],
			details: { op: "create" },
		},
	},

	think: {
		label: "Think",
		// Streaming: scratchpad thoughts still arriving.
		streamingArgs: {
			thoughts: "The retry loop re-reads the config after every failure, which explains the doubled latency.",
		},
		args: {
			thoughts:
				"The retry loop re-reads the config after every failure, which explains the doubled latency. Cache the parsed config outside the loop, then re-check the invalidation path.",
		},
		result: {
			content: [{ type: "text", text: "------" }],
			details: { recorded: true },
		},
	},

	wait: {
		label: "Wait for jobs",
		streamingArgs: {},
		args: {},
		result: {
			content: [{ type: "text", text: "3 jobs settled." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_a1",
						type: "bash",
						status: "completed",
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 pass, 0 fail (18.4s)",
					},
					{
						id: "job_b2",
						type: "eval",
						status: "completed",
						label: "Migrate rate limiter to a sliding window",
						durationMs: 96_700,
						resultText: "Rewrote rate-limit.ts to a token-bucket; added per-account keys.",
					},
					{
						id: "job_c3",
						type: "bash",
						status: "failed",
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome: 2 errors in tokens.ts — noUnusedVariables, useConst",
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "1 job failed." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_d4",
						type: "eval",
						status: "failed",
						label: "Refactor the session store to Redis",
						durationMs: 52_300,
						errorText: "Redis connection string is missing.",
					},
				],
			},
		},
	},

	yield: {
		label: "Submit Result",
		// Streaming: the payload object is still arriving.
		streamingArgs: { data: { summary: "Two races in the session store's flush path." } },
		args: { data: YIELD_DATA },
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: YIELD_DATA } satisfies YieldItem,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Output does not match schema: /confidence must be number. Call yield again with the corrected shape — 2 retry attempt(s) remain before the schema constraint is dropped.",
				},
			],
		},
	},
};

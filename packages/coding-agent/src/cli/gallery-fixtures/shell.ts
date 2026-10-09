/** Gallery fixtures for shell and supervised-service tools. */
import type { GalleryFixture } from "./types";

export const shellFixtures: Record<string, GalleryFixture> = {
	bash: {
		label: "Bash",
		streamingArgs: {
			command: "git status --short && git log --on",
		},
		args: {
			command: "git status --short && git log --oneline -5",
			cwd: "packages/coding-agent",
			timeout: 30,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						" M src/cli/gallery-cli.ts",
						" M src/tools/bash.ts",
						"?? src/cli/gallery-fixtures/shell.ts",
						"a1b2c3d Wire gallery command into CLI dispatch",
						"9f8e7d6 Add ToolExecutionComponent lifecycle states",
						"4c5b6a7 Extract createShellRenderer from bashToolRenderer",
						"2d3e4f5 Strip LLM-facing notices before TUI render",
						"7a8b9c0 Cap preview lines in pending command block",
					].join("\n"),
				},
			],
			details: {
				exitCode: 0,
				wallTimeMs: 184,
				timeoutSeconds: 30,
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: [
						"src/tools/bash.ts:1142:34 - error TS2339: Property 'requestedTimeoutSeconds' does not exist on type 'BashToolDetails'.",
						"",
						"1142   const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;",
						"                                            ~~~~~~~~~~~~~~~~~~~~~~~~",
						"Found 1 error in src/tools/bash.ts:1142",
					].join("\n"),
				},
			],
			isError: true,
			details: {
				exitCode: 2,
				wallTimeMs: 5120,
				timeoutSeconds: 30,
			},
		},
	},

	bash_service: {
		label: "Bash service",
		renderer: "bash",
		streamingArgs: { command: "bun run dev", name: "web" },
		args: {
			command: "bun run dev",
			name: "web",
			ready: { log: "Local:.*http", port: 5173, timeout: 30 },
		},
		result: {
			content: [{ type: "text", text: "web: ready pid=51234 ready\nLocal: http://localhost:5173" }],
			details: {
				service: { name: "web", state: "ready", ready: true, timedOut: false, pid: 51234 },
			},
		},
		errorResult: {
			content: [{ type: "text", text: "web: failed — process exited before readiness" }],
			isError: true,
			details: { service: { name: "web", state: "failed", ready: false, timedOut: false } },
		},
	},
};

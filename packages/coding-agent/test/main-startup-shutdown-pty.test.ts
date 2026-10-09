import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CURRENT_SETUP_VERSION } from "@oh-my-pi/pi-tui/setup/setup-version";
import { TempDir } from "@oh-my-pi/pi-utils";

describe.skipIf(process.platform === "win32")("interactive startup shutdown", () => {
	it.each([true, false])(
		"dispatches the CLI prompt only when startup accepts it (shutdown=%s)",
		async shutdown => {
			using dir = TempDir.createSync("@omp-startup-shutdown-");
			const extension = path.join(dir.path(), "startup.ts");
			const dispatched = path.join(dir.path(), "dispatched");
			const config = path.join(dir.path(), "config.yml");
			await Bun.write(config, `setupVersion: ${CURRENT_SETUP_VERSION}\nstartupSplash: false\n`);
			await Bun.write(
				extension,
				`
export default function(pi) {
	pi.on("session_start", async (_event, ctx) => {
		await ctx.ui.select("Startup decision", ["Resolve startup"]);
		if (${shutdown}) ctx.shutdown();
	});
	pi.registerCommand("probe", {
		description: "Record CLI prompt dispatch",
		handler: async (_args, ctx) => {
			await Bun.write(${JSON.stringify(dispatched)}, "dispatched");
			ctx.shutdown();
		}
	});
}
`,
			);
			let output = "";
			let answered = false;
			await using terminal = new Bun.Terminal({
				cols: 140,
				rows: 35,
				data(terminal, data) {
					const chunk = Buffer.from(data).toString();
					output += chunk;
					if (chunk.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
					if (!answered && output.includes("Resolve startup")) {
						answered = true;
						terminal.write("\r");
					}
				},
			});
			const proc = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "../src/cli.ts"),
					"--config",
					config,
					"--no-extensions",
					"--trusted-extension",
					extension,
					"--session-dir",
					path.join(dir.path(), "sessions"),
					"--no-title",
					"/probe",
				],
				{
					cwd: dir.path(),
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: path.join(dir.path(), "agent"),
						PI_TEST_RUNTIME: undefined,
						BUN_ENV: undefined,
						NODE_ENV: undefined,
						OMP_TUI_DEBUG: undefined,
						TERM: "xterm-256color",
						TERM_PROGRAM: undefined,
						OMP_TUI_NATIVE: "0",
						PI_TUI_NATIVE: "0",
					},
					signal: AbortSignal.timeout(25_000),
					terminal,
				},
			);
			try {
				expect(await proc.exited, output).toBe(0);
				expect(answered, output).toBe(true);
				expect(await Bun.file(dispatched).exists()).toBe(!shutdown);
			} finally {
				if (proc.exitCode === null) proc.kill();
				await proc.exited;
			}
		},
		30_000,
	);
});

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliProcessResult {
	exitCode: number;
	output: string;
	error: string;
}

async function runSetup(cwd: string, ...setupArgs: string[]): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
	};
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", ...setupArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

describe("omp setup without a component", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		await projectDir?.remove();
		projectDir = undefined;
	});

	// Regression: `setup --check --json` with no COMPONENT used to print USAGE to
	// stdout and exit 0, silently succeeding a machine-readable check and breaking
	// scripted `--json` health checks. It must now fail loudly on stderr.
	for (const flags of [["--check"], ["--json"]]) {
		it(`fails on stderr with a non-zero exit for ${["setup", ...flags].join(" ")}`, async () => {
			projectDir = TempDir.createSync("@omp-setup-noarg-");
			const result = await runSetup(projectDir.path(), ...flags);

			expect(result.exitCode).not.toBe(0);
			expect(result.output).toBe("");
			expect(result.error).toContain("requires a COMPONENT");
		});
	}
});

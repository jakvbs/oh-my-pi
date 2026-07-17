import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runCli } from "./index";

const argv = process.argv.slice(2);
const cwdFlagIndex = argv.lastIndexOf("--cwd");
const cwdValue = cwdFlagIndex >= 0 ? argv[cwdFlagIndex + 1] : undefined;
if (!cwdValue || cwdValue.startsWith("--")) {
	process.stderr.write(
		"[dag-runner] bun run example requires --cwd <existing-scratch-directory>; refusing to write into the example source directory.\n",
	);
	process.exit(2);
}

const scratchCwd = path.resolve(cwdValue);
const scratchStats = await fs.stat(scratchCwd).catch(() => undefined);
if (!scratchStats) {
	process.stderr.write(`[dag-runner] --cwd does not exist: ${scratchCwd}\n`);
	process.exit(2);
}
if (!scratchStats.isDirectory()) {
	process.stderr.write(`[dag-runner] --cwd is not a directory: ${scratchCwd}\n`);
	process.exit(2);
}

process.exitCode = await runCli([
	"--dag",
	path.join(import.meta.dir, "example-dag.json"),
	"--canvas-path",
	path.join(scratchCwd, "dag-example.canvas.tsx"),
	...argv,
]);

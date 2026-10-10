import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");

export interface CheckCommand {
	label: string;
	command: string[];
	cwd: string;
}

export async function runChecks(checks: CheckCommand[], logDir: string): Promise<number> {
	if (checks.length === 0) throw new Error("No checks selected.");
	await fs.mkdir(logDir, { recursive: true });
	for (const [index, check] of checks.entries()) {
		const logPath = path.join(logDir, `${index + 1}.log`);
		let code: number;
		let output: string;
		try {
			const result = await $`${check.command}`.cwd(check.cwd).quiet().nothrow();
			code = result.exitCode;
			output = `${result.stdout.toString()}${result.stderr.toString()}`;
		} catch (error) {
			code = 1;
			output = error instanceof Error ? (error.stack ?? error.message) : String(error);
		}
		await Bun.write(logPath, output);
		console.log(`${code === 0 ? "PASS" : "FAIL"} ${check.label} (exit ${code}); log: ${logPath}`);
		if (code !== 0) {
			console.error(output.trimEnd().split("\n").slice(-40).join("\n"));
			return code > 0 && code < 256 ? code : 1;
		}
	}
	return 0;
}

export async function scopeChecks(args: string[]): Promise<CheckCommand[]> {
	const { values } = parseArgs({
		args,
		options: {
			all: { type: "boolean" },
			package: { type: "string", multiple: true },
			file: { type: "string", multiple: true },
		},
	});
	const packages = [...new Set(values.package ?? [])];
	const files = [...new Set(values.file ?? [])];
	if (values.all) {
		if (packages.length || files.length) throw new Error("Use --all or an explicit scope, not both.");
		return [{ label: "workspace TypeScript checks", command: [process.execPath, "run", "check:ts"], cwd: root }];
	}
	if (!packages.length && !files.length) throw new Error("Select --package NAME, --file PATH, or --all (CI).");
	const checks: CheckCommand[] = [];
	const lintPaths: string[] = [];
	for (const name of packages) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid package directory: ${name}`);
		const cwd = path.join(root, "packages", name);
		const manifest = await Bun.file(path.join(cwd, "package.json")).json();
		if (typeof manifest.scripts?.["check:types"] !== "string") {
			throw new Error(`packages/${name} has no check:types script.`);
		}
		checks.push({ label: `${name} types`, command: [process.execPath, "run", "check:types"], cwd });
		lintPaths.push(`packages/${name}`);
	}
	for (const file of files) {
		const relative = path.relative(root, path.resolve(root, file));
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`File must be inside the repository: ${file}`);
		}
		if (!(await fs.stat(path.join(root, relative))).isFile()) throw new Error(`Not a file: ${file}`);
		lintPaths.push(relative);
	}
	checks.push({
		label: "scoped lint",
		command: [path.join(root, "node_modules", ".bin", "oxlint"), "--deny-warnings", "--", ...lintPaths],
		cwd: root,
	});
	return checks;
}

if (import.meta.main) {
	if (process.argv.slice(2).includes("--help")) {
		console.log(
			"Usage: bun run check:scope [--package NAME]... [--file PATH]... | --all\nPackages run check:types and lint. Files run lint only. --all retains the full CI TypeScript gate.",
		);
	} else {
		try {
			const checks = await scopeChecks(process.argv.slice(2));
			const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-check-scope-"));
			process.exitCode = await runChecks(checks, logDir);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}

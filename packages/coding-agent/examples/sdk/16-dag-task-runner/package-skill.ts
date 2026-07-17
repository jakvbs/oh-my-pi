import * as fs from "node:fs/promises";
import * as path from "node:path";

const SKILL_NAME = "dag-task-runner";
const OWNERSHIP_MARKER = ".dag-task-runner.generated.json";
const OWNERSHIP = {
	generatedBy: "oh-my-pi/examples/sdk/16-dag-task-runner/package-skill.ts",
	formatVersion: 1,
};
const EXAMPLE_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(EXAMPLE_DIR, "../../../../..");
const RUNTIME_DEPENDENCIES = [
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-utils",
	"handlebars",
] as const;
const RUNTIME_DEV_DEPENDENCIES = ["@types/bun", "@typescript/native-preview"] as const;

const SOURCE_FILES = [
	["skill/SKILL.md", "SKILL.md"],
	["example-dag.json", "examples/example-dag.json"],
	["index.ts", "runtime/index.ts"],
	["dag.ts", "runtime/dag.ts"],
	["canvas-writer.ts", "runtime/canvas-writer.ts"],
	["run-example.ts", "runtime/run-example.ts"],
	["prompts/task.md", "runtime/prompts/task.md"],
] as const;

const GENERATED_FILES = [
	OWNERSHIP_MARKER,
	"runtime/package.json",
	"runtime/tsconfig.json",
	"runtime/text-imports.d.ts",
	".gitignore",
] as const;

export interface PackagedSkill {
	destination: string;
	files: string[];
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateDestination(destination: string): string {
	if (!destination.trim()) throw new Error("Skill destination must be a non-empty path.");
	const resolved = path.resolve(destination);
	if (path.basename(resolved) !== SKILL_NAME) {
		throw new Error(`Skill destination must end in ${SKILL_NAME}.`);
	}
	if (isWithin(EXAMPLE_DIR, resolved)) {
		throw new Error("Refusing to generate a skill inside the hand-owned example source directory.");
	}
	return resolved;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

async function assertReplaceableDestination(destination: string): Promise<boolean> {
	const stats = await fs.lstat(destination).catch(error => {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	});
	if (!stats) return false;
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Refusing to replace existing unowned destination: ${destination}`);
	}

	const marker = await Bun.file(path.join(destination, OWNERSHIP_MARKER))
		.json()
		.catch(() => undefined);
	if (
		typeof marker !== "object" ||
		marker === null ||
		Reflect.get(marker, "generatedBy") !== OWNERSHIP.generatedBy ||
		Reflect.get(marker, "formatVersion") !== OWNERSHIP.formatVersion
	) {
		throw new Error(`Refusing to replace existing unowned destination: ${destination}`);
	}
	return true;
}

function catalogDependencies(catalog: object, names: readonly string[]): Record<string, string> {
	return Object.fromEntries(
		names.map(name => {
			const version = Reflect.get(catalog, name);
			if (typeof version !== "string" || !version) {
				throw new Error(`Workspace catalog has no version for ${name}.`);
			}
			return [name, version];
		}),
	);
}

async function runtimePackageJson(): Promise<string> {
	const manifest: unknown = await Bun.file(path.join(REPO_ROOT, "package.json")).json();
	const workspaces =
		typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "workspaces") : undefined;
	const catalog =
		typeof workspaces === "object" && workspaces !== null ? Reflect.get(workspaces, "catalog") : undefined;
	if (typeof catalog !== "object" || catalog === null) {
		throw new Error("Workspace dependency catalog is unavailable.");
	}

	const dependencies = catalogDependencies(catalog, RUNTIME_DEPENDENCIES);
	const devDependencies = catalogDependencies(catalog, RUNTIME_DEV_DEPENDENCIES);

	return `${JSON.stringify(
		{
			name: "dag-task-runner-skill-runtime",
			version: "0.1.0",
			private: true,
			type: "module",
			description: "Self-contained OMP SDK runtime for the dag-task-runner skill.",
			engines: { bun: ">=1.3.14" },
			scripts: {
				run: "bun index.ts",
				"init-canvas":
					"bun index.ts --init-only --dag ../examples/example-dag.json --canvas-path .canvas/dag-example.canvas.tsx",
				example: "bun run-example.ts --dag ../examples/example-dag.json",
				check: "tsgo -p tsconfig.json --noEmit",
			},
			dependencies,
			devDependencies,
		},
		null,
		2,
	)}\n`;
}

function runtimeTsconfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				target: "ESNext",
				module: "Preserve",
				moduleResolution: "bundler",
				allowImportingTsExtensions: true,
				strict: true,
				skipLibCheck: true,
				types: ["bun"],
			},
			include: ["./**/*.ts"],
		},
		null,
		2,
	)}\n`;
}

async function writeGeneratedFiles(staging: string): Promise<void> {
	await Bun.write(path.join(staging, OWNERSHIP_MARKER), `${JSON.stringify(OWNERSHIP, null, 2)}\n`);
	await Bun.write(path.join(staging, "runtime/package.json"), await runtimePackageJson());
	await Bun.write(path.join(staging, "runtime/tsconfig.json"), runtimeTsconfig());
	await Bun.write(
		path.join(staging, "runtime/text-imports.d.ts"),
		'declare module "*.md" {\n\tconst content: string;\n\texport default content;\n}\n',
	);
	await Bun.write(
		path.join(staging, ".gitignore"),
		["runtime/node_modules/", "runtime/.canvas/", "runtime/bun.lock", "*.tsbuildinfo", ".DS_Store", ""].join("\n"),
	);
}

export async function packageSkill(destination: string): Promise<PackagedSkill> {
	const requestedDestination = validateDestination(destination);
	const requestedParent = path.dirname(requestedDestination);
	await fs.mkdir(requestedParent, { recursive: true });
	const destinationParent = await fs.realpath(requestedParent);
	const resolvedDestination = path.join(destinationParent, SKILL_NAME);
	if (isWithin(EXAMPLE_DIR, resolvedDestination)) {
		throw new Error("Refusing to generate a skill inside the hand-owned example source directory.");
	}
	const replacing = await assertReplaceableDestination(resolvedDestination);
	const staging = await fs.mkdtemp(path.join(destinationParent, `.${SKILL_NAME}-`));

	try {
		for (const [source, target] of SOURCE_FILES) {
			const targetPath = path.join(staging, target);
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(path.join(EXAMPLE_DIR, source), targetPath);
		}
		await writeGeneratedFiles(staging);
		if (replacing) {
			await assertReplaceableDestination(resolvedDestination);
			await fs.rm(resolvedDestination, { recursive: true });
		}
		await fs.rename(staging, resolvedDestination);
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}

	return {
		destination: resolvedDestination,
		files: [...SOURCE_FILES.map(([, target]) => target), ...GENERATED_FILES].sort(),
	};
}

async function main(): Promise<void> {
	const [destination, ...extra] = process.argv.slice(2);
	if (!destination || extra.length > 0 || destination === "--help" || destination === "-h") {
		process.stderr.write(`Usage: bun package-skill.ts <explicit-path-ending-in-${SKILL_NAME}>\n`);
		process.exitCode = destination === "--help" || destination === "-h" ? 0 : 2;
		return;
	}
	const packaged = await packageSkill(destination);
	process.stdout.write(`[dag-runner] packaged ${packaged.files.length} files → ${packaged.destination}\n`);
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(`[dag-runner] package failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

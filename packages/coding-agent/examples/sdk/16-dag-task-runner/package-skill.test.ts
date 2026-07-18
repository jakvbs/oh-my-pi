import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { packageSkill } from "./package-skill";

const EXPECTED_FILES = [
	".dag-task-runner.generated.json",
	".gitignore",
	"SKILL.md",
	"examples/example-dag.json",
	"runtime/canvas-writer.ts",
	"runtime/checkpoint.ts",
	"runtime/dag.ts",
	"runtime/index.ts",
	"runtime/package.json",
	"runtime/preflight.ts",
	"runtime/prompts/preflight-review.md",
	"runtime/prompts/preflight-system.md",
	"runtime/prompts/task.md",
	"runtime/run-example.ts",
	"runtime/text-imports.d.ts",
	"runtime/tsconfig.json",
];

describe("copyable skill packaging", () => {
	test("emits a self-contained generated skill and replaces stale output", async () => {
		using tempDir = TempDir.createSync("@omp-dag-skill-");
		const destination = path.join(tempDir.path(), "dag-task-runner");
		const packaged = await packageSkill(destination);

		expect(packaged).toEqual({ destination: await fs.realpath(destination), files: EXPECTED_FILES });
		expect(await Bun.file(path.join(destination, "SKILL.md")).text()).toBe(
			await Bun.file(path.join(import.meta.dir, "skill/SKILL.md")).text(),
		);
		expect(await Bun.file(path.join(destination, "runtime/prompts/task.md")).text()).toBe(
			await Bun.file(path.join(import.meta.dir, "prompts/task.md")).text(),
		);
		expect(await Bun.file(path.join(destination, "examples/example-dag.json")).json()).toEqual(
			await Bun.file(path.join(import.meta.dir, "example-dag.json")).json(),
		);

		const manifest = await Bun.file(path.join(destination, "runtime/package.json")).json();
		expect(manifest.scripts).toEqual({
			run: "bun index.ts",
			"init-canvas":
				"bun index.ts --init-only --dag ../examples/example-dag.json --canvas-path .canvas/dag-example.canvas.tsx",
			example: "bun run-example.ts --dag ../examples/example-dag.json",
			check: "tsgo -p tsconfig.json --noEmit",
		});
		const rootManifest = await Bun.file(path.resolve(import.meta.dir, "../../../../..", "package.json")).json();
		expect(manifest.dependencies).toEqual({
			"@oh-my-pi/pi-ai": rootManifest.workspaces.catalog["@oh-my-pi/pi-ai"],
			"@oh-my-pi/pi-coding-agent": rootManifest.workspaces.catalog["@oh-my-pi/pi-coding-agent"],
			"@oh-my-pi/pi-utils": rootManifest.workspaces.catalog["@oh-my-pi/pi-utils"],
			handlebars: rootManifest.workspaces.catalog.handlebars,
			zod: rootManifest.workspaces.catalog.zod,
		});
		expect(manifest.devDependencies).toEqual({
			"@types/bun": rootManifest.workspaces.catalog["@types/bun"],
			"@typescript/native-preview": rootManifest.workspaces.catalog["@typescript/native-preview"],
		});

		await Bun.write(path.join(destination, "stale.txt"), "stale");
		await packageSkill(destination);
		expect(await Bun.file(path.join(destination, "stale.txt")).exists()).toBe(false);
	});

	test("refuses to replace an existing unowned destination", async () => {
		using tempDir = TempDir.createSync("@omp-dag-skill-unowned-");
		const destination = path.join(tempDir.path(), "dag-task-runner");
		await fs.mkdir(destination);
		await Bun.write(path.join(destination, "keep.txt"), "user data");

		await expect(packageSkill(destination)).rejects.toThrow("existing unowned destination");
		expect(await Bun.file(path.join(destination, "keep.txt")).text()).toBe("user data");
	});

	test("requires an explicit dag-task-runner destination outside the source tree", async () => {
		await expect(packageSkill("/tmp/not-the-skill")).rejects.toThrow("must end in dag-task-runner");
		await expect(packageSkill(path.join(import.meta.dir, "generated", "dag-task-runner"))).rejects.toThrow(
			"hand-owned example source",
		);
	});
});

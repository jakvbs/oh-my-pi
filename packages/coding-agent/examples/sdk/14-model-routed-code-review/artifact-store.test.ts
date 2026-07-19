import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeJsonArtifact, writeJsonArtifactDirectory } from "./artifact-store";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-artifact-store-"));
	try {
		await run(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("writeJsonArtifact", () => {
	test("never publishes partial JSON while a write is in flight", async () => {
		await withTempDirectory(async directory => {
			const destination = path.join(directory, "report.json");
			const value = { payload: "x".repeat(8 * 1024 * 1024) };
			const expected = `${JSON.stringify(value, null, 2)}\n`;
			let settled = false;
			let observedPartial = false;
			const writing = writeJsonArtifact(destination, value).finally(() => {
				settled = true;
			});

			while (!settled) {
				try {
					if ((await Bun.file(destination).text()) !== expected) observedPartial = true;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				await Bun.sleep(0);
			}

			expect(await writing).toEqual({ ok: true, value: destination });
			expect(observedPartial).toBe(false);
			expect(await Bun.file(destination).text()).toBe(expected);
			expect((await fs.readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	test("preserves an existing destination and returns a typed IO failure", async () => {
		await withTempDirectory(async directory => {
			const destination = path.join(directory, "report.json");
			await Bun.write(destination, "existing\n");

			const outcome = await writeJsonArtifact(destination, { replacement: true });

			expect(outcome).toEqual({
				ok: false,
				failure: {
					kind: "artifact_io_failed",
					operation: "write",
					path: destination,
					message: `Refusing to overwrite existing output: ${destination}`,
				},
			});
			expect(await Bun.file(destination).text()).toBe("existing\n");
			expect((await fs.readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		});
	});
});

describe("writeJsonArtifactDirectory", () => {
	test("publishes the complete artifact set with one directory rename", async () => {
		await withTempDirectory(async directory => {
			const destination = path.join(directory, "units");
			const artifacts = [
				{ fileName: "alpha.json", value: { unitId: "alpha", payload: "a".repeat(4 * 1024 * 1024) } },
				{ fileName: "beta.json", value: { unitId: "beta", payload: "b".repeat(4 * 1024 * 1024) } },
			];
			let settled = false;
			let observedPartial = false;
			const writing = writeJsonArtifactDirectory(destination, artifacts).finally(() => {
				settled = true;
			});

			while (!settled) {
				try {
					const names = await fs.readdir(destination);
					if (names.sort().join(",") !== "alpha.json,beta.json") observedPartial = true;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				await Bun.sleep(0);
			}

			expect(await writing).toEqual({
				ok: true,
				value: [path.join(destination, "alpha.json"), path.join(destination, "beta.json")],
			});
			expect(observedPartial).toBe(false);
			expect((await fs.readdir(destination)).sort()).toEqual(["alpha.json", "beta.json"]);
		});
	});

	test("refuses an existing output directory without changing it", async () => {
		await withTempDirectory(async directory => {
			const destination = path.join(directory, "units");
			await fs.mkdir(destination);
			await Bun.write(path.join(destination, "existing.json"), "existing\n");

			const outcome = await writeJsonArtifactDirectory(destination, [{ fileName: "alpha.json", value: {} }]);

			expect(outcome).toEqual({
				ok: false,
				failure: {
					kind: "artifact_io_failed",
					operation: "publish",
					path: destination,
					message: `Refusing to overwrite existing output directory: ${destination}`,
				},
			});
			expect(await Bun.file(path.join(destination, "existing.json")).text()).toBe("existing\n");
		});
	});
});

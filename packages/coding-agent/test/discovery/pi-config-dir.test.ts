import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";

describe("PI_CONFIG_DIR", () => {
	const original = process.env.PI_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = original;
		}
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		process.env.PI_CONFIG_DIR = ".config/omp";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/omp", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".omp", level: "user" });
	});
});

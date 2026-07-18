import * as fs from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isEexist } from "@oh-my-pi/pi-utils";
import type { ReviewOutcome } from "./contracts";

export async function writeJsonArtifact(outputPath: string, value: unknown): Promise<ReviewOutcome<string>> {
	const absolutePath = resolve(outputPath);
	const temporaryPath = resolve(
		dirname(absolutePath),
		`.${basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	try {
		await fs.mkdir(dirname(absolutePath), { recursive: true });
		await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await fs.link(temporaryPath, absolutePath);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		return { ok: true, value: absolutePath };
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		return {
			ok: false,
			failure: {
				kind: "invalid_plan",
				reason: "schema",
				message: isEexist(error)
					? `Refusing to overwrite existing output: ${absolutePath}`
					: `Failed to write JSON artifact: ${String(error)}`,
				target: absolutePath,
			},
		};
	}
}

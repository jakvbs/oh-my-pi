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
				kind: "artifact_io_failed",
				operation: "write",
				path: absolutePath,
				message: isEexist(error)
					? `Refusing to overwrite existing output: ${absolutePath}`
					: `Failed to write JSON artifact: ${String(error)}`,
			},
		};
	}
}

/** Publish a complete directory through one no-clobber symlink creation. The hidden sibling directory is backing storage. */
export async function writeJsonArtifactDirectory(
	outputDirectory: string,
	artifacts: readonly { fileName: string; value: unknown }[],
): Promise<ReviewOutcome<string[]>> {
	const absoluteDirectory = resolve(outputDirectory);
	const parentDirectory = dirname(absoluteDirectory);
	const backingDirectory = resolve(
		parentDirectory,
		`.${basename(absoluteDirectory)}.${process.pid}.${crypto.randomUUID()}.data`,
	);

	for (const artifact of artifacts) {
		if (artifact.fileName !== basename(artifact.fileName) || artifact.fileName === ".") {
			return {
				ok: false,
				failure: {
					kind: "artifact_io_failed",
					operation: "write",
					path: absoluteDirectory,
					message: `Artifact file name must be a basename: ${artifact.fileName}`,
				},
			};
		}
	}

	try {
		await fs.mkdir(parentDirectory, { recursive: true });
		await fs.mkdir(backingDirectory);
		await Promise.all(
			artifacts.map(artifact =>
				fs.writeFile(resolve(backingDirectory, artifact.fileName), `${JSON.stringify(artifact.value, null, 2)}\n`, {
					encoding: "utf8",
					flag: "wx",
				}),
			),
		);
		const symlinkTarget = process.platform === "win32" ? backingDirectory : basename(backingDirectory);
		await fs.symlink(symlinkTarget, absoluteDirectory, process.platform === "win32" ? "junction" : "dir");
		return {
			ok: true,
			value: artifacts.map(artifact => resolve(absoluteDirectory, artifact.fileName)),
		};
	} catch (error) {
		await fs.rm(backingDirectory, { recursive: true, force: true }).catch(() => undefined);
		return {
			ok: false,
			failure: {
				kind: "artifact_io_failed",
				operation: "publish",
				path: absoluteDirectory,
				message: isEexist(error)
					? `Refusing to overwrite existing output directory: ${absoluteDirectory}`
					: `Failed to publish JSON artifact directory: ${String(error)}`,
			},
		};
	}
}

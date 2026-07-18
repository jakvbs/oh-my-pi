import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import type { RunState, TaskState } from "./canvas-writer";

const CHECKPOINT_VERSION = 1;

const savedTaskSchema = z.object({
	id: z.string().min(1),
	status: z.enum(["PENDING", "RUNNING", "FINISHED", "ERROR"]),
	startedAt: z.number().nonnegative().optional(),
	finishedAt: z.number().nonnegative().optional(),
	resultText: z.string().optional(),
	errorMessage: z.string().optional(),
	inputTokens: z.number().nonnegative().optional(),
	outputTokens: z.number().nonnegative().optional(),
	durationMs: z.number().nonnegative().optional(),
});

const checkpointSchema = z.object({
	version: z.number().int(),
	dagHash: z.string().min(1),
	cwd: z.string().min(1),
	updatedAt: z.number().nonnegative(),
	state: z.object({ tasks: z.array(savedTaskSchema) }),
});

type SavedTask = z.infer<typeof savedTaskSchema>;

export function checkpointPathForCanvas(canvasPath: string): string {
	return canvasPath.endsWith(".canvas.tsx")
		? `${canvasPath.slice(0, -".canvas.tsx".length)}.checkpoint.json`
		: `${canvasPath}.checkpoint.json`;
}

export class CheckpointStore {
	readonly #path: string;
	readonly #dagHash: string;
	readonly #cwd: string;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(checkpointPath: string, dagHash: string, cwd: string) {
		this.#path = checkpointPath;
		this.#dagHash = dagHash;
		this.#cwd = cwd;
	}

	static async open(canvasPath: string, dagHash: string, cwd: string): Promise<CheckpointStore> {
		return new CheckpointStore(checkpointPathForCanvas(canvasPath), dagHash, await fs.realpath(cwd));
	}

	get path(): string {
		return this.#path;
	}

	async loadResumeState(freshState: RunState): Promise<RunState> {
		let raw: unknown;
		try {
			raw = await Bun.file(this.#path).json();
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Resume checkpoint not found: ${this.#path}`);
			throw new Error(
				`Failed to read resume checkpoint ${this.#path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const parsed = checkpointSchema.safeParse(raw);
		if (!parsed.success) {
			const details = parsed.error.issues
				.map(issue => `${issue.path.join(".") || "checkpoint"}: ${issue.message}`)
				.join("; ");
			throw new Error(`Invalid resume checkpoint ${this.#path}: ${details}`);
		}
		if (parsed.data.version !== CHECKPOINT_VERSION) {
			throw new Error(
				`Unsupported resume checkpoint version ${parsed.data.version}; expected ${CHECKPOINT_VERSION}: ${this.#path}`,
			);
		}
		if (parsed.data.dagHash !== this.#dagHash) {
			throw new Error(`Resume checkpoint DAG hash mismatch: ${this.#path}`);
		}
		if (parsed.data.cwd !== this.#cwd) {
			throw new Error(`Resume checkpoint cwd mismatch: expected ${this.#cwd}, found ${parsed.data.cwd}`);
		}

		const savedById = new Map<string, SavedTask>();
		for (const task of parsed.data.state.tasks) {
			if (savedById.has(task.id)) throw new Error(`Resume checkpoint contains duplicate task id: ${task.id}`);
			savedById.set(task.id, task);
		}
		if (savedById.size !== freshState.tasks.length) {
			throw new Error(`Resume checkpoint task set does not match the DAG: ${this.#path}`);
		}
		for (const task of freshState.tasks) {
			if (!savedById.has(task.id)) throw new Error(`Resume checkpoint is missing task: ${task.id}`);
		}

		return {
			...freshState,
			tasks: freshState.tasks.map(task => restoreTask(task, savedById.get(task.id)!)),
		};
	}

	write(state: RunState): Promise<void> {
		const checkpoint = {
			version: CHECKPOINT_VERSION,
			dagHash: this.#dagHash,
			cwd: this.#cwd,
			updatedAt: Date.now(),
			state: structuredClone(state),
		};
		const write = this.#writeTail.then(() => writeJsonAtomic(this.#path, checkpoint));
		this.#writeTail = write.catch(() => {});
		return write;
	}
}

function restoreTask(freshTask: TaskState, savedTask: SavedTask): TaskState {
	if (savedTask.status === "FINISHED") {
		return {
			...freshTask,
			status: "FINISHED",
			startedAt: savedTask.startedAt,
			finishedAt: savedTask.finishedAt,
			resultText: savedTask.resultText,
			inputTokens: savedTask.inputTokens,
			outputTokens: savedTask.outputTokens,
			durationMs: savedTask.durationMs,
		};
	}

	if (savedTask.startedAt === undefined) return freshTask;
	return {
		...freshTask,
		previousAttempt: {
			errorMessage: savedTask.errorMessage,
			resultText: savedTask.resultText,
		},
	};
}

async function writeJsonAtomic(outputPath: string, value: unknown): Promise<void> {
	const absolutePath = path.resolve(outputPath);
	const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await Bun.write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
		await fs.rename(temporaryPath, absolutePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

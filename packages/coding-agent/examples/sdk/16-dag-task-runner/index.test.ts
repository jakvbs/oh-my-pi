import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initialRunState, renderCanvasSource, type TaskState } from "./canvas-writer";
import { checkpointPathForCanvas } from "./checkpoint";
import { computeRanks, createModelResolver, parseDAG, validateModelMap } from "./dag";
import {
	BoundedTextBuffer,
	buildTaskPrompt,
	defaultCanvasesDir,
	executeDAG,
	mergeModelOverrides,
	parseArgs,
	type RunnerAssistantMessage,
	type RunnerSession,
	type RunnerSessionEvent,
	sdkModelSelection,
	sdkSessionEventKind,
	terminalAssistantError,
} from "./index";

class FakeRunnerSession implements RunnerSession {
	readonly #listeners = new Set<(event: RunnerSessionEvent) => void>();
	readonly #run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>;
	readonly #onDispose: () => void;
	readonly #onAbort: (() => void) | undefined;
	#messages: RunnerAssistantMessage[] = [];
	#streaming = false;

	constructor(
		run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>,
		onDispose: () => void,
		onAbort?: () => void,
	) {
		this.#run = run;
		this.#onDispose = onDispose;
		this.#onAbort = onAbort;
	}

	get isStreaming(): boolean {
		return this.#streaming;
	}

	subscribe(listener: (event: RunnerSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(prompt: string): Promise<void> {
		this.#streaming = true;
		try {
			this.#messages = await this.#run(prompt, event => {
				for (const listener of this.#listeners) listener(event);
			});
		} finally {
			this.#streaming = false;
		}
	}

	getAssistantMessages(): RunnerAssistantMessage[] {
		return this.#messages;
	}

	async abort(): Promise<void> {
		this.#onAbort?.();
		this.#streaming = false;
	}

	async dispose(): Promise<void> {
		this.#onDispose();
	}
}

describe("DAG parity", () => {
	test("deduplicates dependencies and preserves deterministic source-order ranks", () => {
		const dag = parseDAG({
			title: " demo ",
			goal: "Test goal",
			success_criteria: ["Criterion"],
			tasks: [
				{ id: "a", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "A" },
				{ id: "b", depends_on: [], context_from: [], writes: [], complexity: "MED", subtask_prompt: "B" },
				{
					id: "c",
					depends_on: ["a", "a", "b"],
					context_from: ["a", "a", "b"],
					writes: ["out.txt", "out.txt"],
					complexity: "HIGH",
					subtask_prompt: "C",
				},
			],
		});

		expect(dag.title).toBe(" demo ");
		expect(dag.tasks[2].depends_on).toEqual(["a", "b"]);
		expect(dag.tasks[2].context_from).toEqual(["a", "b"]);
		expect(dag.tasks[2].writes).toEqual(["out.txt"]);
		expect(computeRanks(dag).map(rank => rank.map(task => task.id))).toEqual([["a", "b"], ["c"]]);
	});

	test("rejects invalid references and cycles", () => {
		expect(() =>
			parseDAG({
				title: "bad",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [
					{
						id: "a",
						depends_on: ["missing"],
						context_from: [],
						writes: [],
						complexity: "LOW",
						subtask_prompt: "A",
					},
				],
			}),
		).toThrow("Task a depends_on unknown id: missing");
		expect(() =>
			parseDAG({
				title: "cycle",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [
					{ id: "a", depends_on: ["b"], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "A" },
					{ id: "b", depends_on: ["a"], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "B" },
				],
			}),
		).toThrow("Cycle detected: a -> b -> a");
	});

	test("requires explicit context and write declarations", () => {
		expect(() =>
			parseDAG({
				title: "missing context",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [{ id: "a", depends_on: [], writes: [], complexity: "LOW", subtask_prompt: "A" }],
			}),
		).toThrow("tasks[0].context_from must be an array of strings");
		expect(() =>
			parseDAG({
				title: "missing writes",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [{ id: "a", depends_on: [], context_from: [], complexity: "LOW", subtask_prompt: "A" }],
			}),
		).toThrow("tasks[0].writes must be an array of strings");
	});

	test("requires context sources to be scheduling dependencies", () => {
		expect(() =>
			parseDAG({
				title: "bad context",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [
					{ id: "a", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "A" },
					{
						id: "b",
						depends_on: ["a"],
						context_from: ["other"],
						writes: [],
						complexity: "LOW",
						subtask_prompt: "B",
					},
				],
			}),
		).toThrow("Task b context_from must be a subset of depends_on: other");
	});

	test("rejects unsafe or unordered writes while allowing an ordered shared path", () => {
		expect(() =>
			parseDAG({
				title: "unsafe path",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [
					{
						id: "a",
						depends_on: [],
						context_from: [],
						writes: ["../outside.txt"],
						complexity: "LOW",
						subtask_prompt: "A",
					},
				],
			}),
		).toThrow('must be "*" or an exact normalized repo-relative path');
		expect(() =>
			parseDAG({
				title: "write conflict",
				goal: "Test goal",
				success_criteria: ["Criterion"],
				tasks: [
					{ id: "a", depends_on: [], context_from: [], writes: ["*"], complexity: "LOW", subtask_prompt: "A" },
					{
						id: "b",
						depends_on: [],
						context_from: [],
						writes: ["src/shared.ts"],
						complexity: "LOW",
						subtask_prompt: "B",
					},
				],
			}),
		).toThrow("Tasks a and b have unordered overlapping writes: src/shared.ts");

		const ordered = parseDAG({
			title: "ordered writes",
			goal: "Test goal",
			success_criteria: ["Criterion"],
			tasks: [
				{
					id: "a",
					depends_on: [],
					context_from: [],
					writes: ["src/shared.ts"],
					complexity: "LOW",
					subtask_prompt: "A",
				},
				{
					id: "b",
					depends_on: ["a"],
					context_from: [],
					writes: ["src/shared.ts"],
					complexity: "LOW",
					subtask_prompt: "B",
				},
			],
		});
		expect(ordered.tasks[1].writes).toEqual(["src/shared.ts"]);
	});

	test("merges and trims model overrides with file precedence", () => {
		const dagModels = validateModelMap({ MED: " dag-med ", LOW: "dag-low" });
		const fileModels = validateModelMap({ MED: " file-med " });
		const resolver = createModelResolver(mergeModelOverrides({ dagModels, fileModels }));

		expect(resolver("HIGH")).toBe("gpt-5.3-codex");
		expect(resolver("MED")).toBe("file-med");
		expect(resolver("LOW")).toBe("dag-low");
	});
});

test("starts a dependent as soon as its own parents finish", async () => {
	using tempDir = TempDir.createSync("@omp-dag-node-ready-");
	const childStarted = Promise.withResolvers<void>();
	const events: string[] = [];
	const dag = parseDAG({
		title: "Node-ready scheduling",
		goal: "Test goal",
		success_criteria: ["Criterion"],
		tasks: [
			{
				id: "slow-root",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "SLOW ROOT",
			},
			{
				id: "fast-root",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "FAST ROOT",
			},
			{
				id: "child",
				depends_on: ["fast-root"],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "CHILD",
			},
		],
	});
	const sessionFactory = () =>
		Promise.resolve(
			new FakeRunnerSession(
				async prompt => {
					if (prompt.startsWith("SLOW ROOT")) {
						events.push("slow:start");
						await childStarted.promise;
						events.push("slow:end");
					} else if (prompt.startsWith("FAST ROOT")) {
						events.push("fast");
					} else {
						expect(prompt).toContain("CHILD");
						events.push("child:start");
						childStarted.resolve();
					}
					return [{ contentText: "done", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {},
			),
		);

	const state = await executeDAG(
		dag,
		{
			dag: "unused.json",
			canvasPath: tempDir.join("run.canvas.tsx"),
			cwd: tempDir.path(),
			debounceMs: 1,
			taskTimeoutMs: 500,
			streamPublishMs: 1,
			streamIdleTimeoutMs: 500,
			semanticPreflight: false,
			reviewOnly: false,
			reviewModel: "@default",
			reviewTimeoutMs: 120_000,
			initOnly: false,
			resume: false,
		},
		sessionFactory,
	);

	expect(state.runOutcome).toBe("SUCCESS");
	expect(events.indexOf("child:start")).toBeLessThan(events.indexOf("slow:end"));
});

test("executes concurrent siblings through the session adapter and cascades provider failure skips", async () => {
	using tempDir = TempDir.createSync("@omp-dag-runner-");
	const rankOneReady = Promise.withResolvers<void>();
	const rankOneStarted = new Set<string>();
	const prompts: string[] = [];
	let disposed = 0;
	let childPrompt = "";

	const dag = parseDAG({
		title: "Adapter contract",
		goal: "Test goal",
		success_criteria: ["Criterion"],
		tasks: [
			{ id: "parent-a", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "ROOT:A" },
			{ id: "parent-b", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "ROOT:B" },
			{
				id: "bad-parent",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "ROOT:BAD",
			},
			{
				id: "child",
				depends_on: ["parent-a", "parent-b"],
				context_from: ["parent-a", "parent-b"],
				writes: [],
				complexity: "MED",
				subtask_prompt: "CHILD",
			},
			{
				id: "bad-child",
				depends_on: ["bad-parent"],
				context_from: [],
				writes: [],
				complexity: "MED",
				subtask_prompt: "BAD CHILD",
			},
			{
				id: "bad-grandchild",
				depends_on: ["bad-child"],
				context_from: [],
				writes: [],
				complexity: "HIGH",
				subtask_prompt: "BAD GRANDCHILD",
			},
		],
	});
	const args = {
		dag: "unused.json",
		canvasPath: tempDir.join("run.canvas.tsx"),
		cwd: tempDir.path(),
		debounceMs: 1,
		taskTimeoutMs: 1_000,
		streamPublishMs: 1,
		streamIdleTimeoutMs: 1_000,
		semanticPreflight: false,
		reviewOnly: false,
		reviewModel: "@default",
		reviewTimeoutMs: 120_000,
		initOnly: false,
		resume: false,
	};
	const sessionFactory = () =>
		Promise.resolve(
			new FakeRunnerSession(
				async (prompt, publish) => {
					prompts.push(prompt);
					if (prompt.startsWith("ROOT:")) {
						rankOneStarted.add(prompt);
						if (rankOneStarted.size === 3) rankOneReady.resolve();
						await rankOneReady.promise;
					}
					if (prompt === "ROOT:BAD") {
						publish({ type: "terminal" });
						return [
							{
								contentText: "",
								errorMessage: "provider failed",
								inputTokens: 1,
								outputTokens: 0,
								stopReason: "error",
							},
						];
					}
					if (prompt.includes("CHILD")) childPrompt = prompt;
					const contentText = prompt === "ROOT:A" ? "output-a" : prompt === "ROOT:B" ? "output-b" : "child-output";
					publish({ type: "text_delta", delta: contentText });
					publish({ type: "terminal" });
					return [{ contentText, inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {
					disposed++;
				},
			),
		);

	const state = await executeDAG(dag, args, sessionFactory);

	expect(rankOneStarted).toEqual(new Set(["ROOT:A", "ROOT:B", "ROOT:BAD"]));
	expect(prompts).toHaveLength(4);
	expect(childPrompt).toBe(
		`Upstream task results (for context — do not re-do this work):

### parent-a [FINISHED]
output-a

### parent-b [FINISHED]
output-b

---

CHILD`,
	);
	expect(state.runOutcome).toBe("FAILED");
	expect(state.runMessage).toBe("Some tasks failed: bad-parent, bad-child, bad-grandchild");
	expect(state.tasks.map(task => [task.id, task.status])).toEqual([
		["parent-a", "FINISHED"],
		["parent-b", "FINISHED"],
		["bad-parent", "ERROR"],
		["child", "FINISHED"],
		["bad-child", "ERROR"],
		["bad-grandchild", "ERROR"],
	]);
	expect(state.tasks[4].errorMessage).toBe("Skipped: upstream task(s) bad-parent failed");
	expect(state.tasks[5].errorMessage).toBe("Skipped: upstream task(s) bad-child failed");
	expect(disposed).toBe(4);
	expect(await Bun.file(args.canvasPath).text()).toContain('"runOutcome": "FAILED"');
});

test("resumes only unfinished tasks and rejects a stale DAG checkpoint", async () => {
	using tempDir = TempDir.createSync("@omp-dag-resume-");
	const dag = parseDAG({
		title: "Resume",
		goal: "Complete the recoverable DAG",
		success_criteria: ["Every task finishes"],
		tasks: [
			{
				id: "completed-root",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "COMPLETED ROOT",
			},
			{
				id: "failed-root",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "FAILED ROOT",
			},
			{
				id: "failed-child",
				depends_on: ["failed-root"],
				context_from: ["failed-root"],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "FAILED CHILD",
			},
			{
				id: "independent-root",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "INDEPENDENT ROOT",
			},
		],
	});
	const args = {
		dag: "unused.json",
		canvasPath: tempDir.join("resume.canvas.tsx"),
		cwd: tempDir.path(),
		debounceMs: 1,
		taskTimeoutMs: 1_000,
		streamPublishMs: 1,
		streamIdleTimeoutMs: 1_000,
		initOnly: false,
		resume: false,
		semanticPreflight: false,
		reviewOnly: false,
		reviewModel: "@default",
		reviewTimeoutMs: 120_000,
	};
	const firstPrompts: string[] = [];
	const first = await executeDAG(dag, args, () =>
		Promise.resolve(
			new FakeRunnerSession(
				async (prompt, publish) => {
					firstPrompts.push(prompt);
					if (prompt === "FAILED ROOT") {
						publish({ type: "text_delta", delta: "partial change" });
						return [
							{
								contentText: "",
								errorMessage: "provider failed",
								inputTokens: 1,
								outputTokens: 1,
								stopReason: "error",
							},
						];
					}
					return [{ contentText: `${prompt} done`, inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {},
			),
		),
	);

	expect(first.runOutcome).toBe("FAILED");
	expect(firstPrompts).toEqual(expect.arrayContaining(["COMPLETED ROOT", "FAILED ROOT", "INDEPENDENT ROOT"]));
	expect(firstPrompts).not.toContain("FAILED CHILD");
	const checkpointPath = checkpointPathForCanvas(args.canvasPath);
	expect((await Bun.file(checkpointPath).json()).state.tasks.map((task: TaskState) => [task.id, task.status])).toEqual(
		[
			["completed-root", "FINISHED"],
			["failed-root", "ERROR"],
			["failed-child", "ERROR"],
			["independent-root", "FINISHED"],
		],
	);

	const resumedPrompts: string[] = [];
	const resumed = await executeDAG(dag, { ...args, resume: true }, () =>
		Promise.resolve(
			new FakeRunnerSession(
				async prompt => {
					resumedPrompts.push(prompt);
					const contentText = prompt.endsWith("FAILED ROOT") ? "repaired root" : "completed child";
					return [{ contentText, inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {},
			),
		),
	);

	expect(resumed.runOutcome).toBe("SUCCESS");
	expect(resumedPrompts).toHaveLength(2);
	expect(resumedPrompts[0]).toContain("Previous attempt did not finish successfully");
	expect(resumedPrompts[0]).toContain("provider failed");
	expect(resumedPrompts[0]).toContain("partial change");
	expect(resumedPrompts[0]).toEndWith("FAILED ROOT");
	expect(resumedPrompts[1]).toContain("repaired root");
	expect(resumedPrompts[1]).toEndWith("FAILED CHILD");
	expect(resumed.tasks.map(task => [task.id, task.status])).toEqual([
		["completed-root", "FINISHED"],
		["failed-root", "FINISHED"],
		["failed-child", "FINISHED"],
		["independent-root", "FINISHED"],
	]);

	let staleCheckpointSessions = 0;
	await expect(
		executeDAG(parseDAG({ ...dag, goal: "Changed goal" }), { ...args, resume: true }, async () => {
			staleCheckpointSessions++;
			throw new Error("session must not start");
		}),
	).rejects.toThrow("DAG hash mismatch");
	expect(staleCheckpointSessions).toBe(0);
});

test("persists RUNNING before session work and retries it on resume", async () => {
	using tempDir = TempDir.createSync("@omp-dag-resume-running-");
	const dag = parseDAG({
		title: "Interrupted resume",
		goal: "Retry interrupted work",
		success_criteria: ["The interrupted task finishes"],
		tasks: [
			{
				id: "interrupted",
				depends_on: [],
				context_from: [],
				writes: [],
				complexity: "LOW",
				subtask_prompt: "INTERRUPTED TASK",
			},
		],
	});
	const args = {
		dag: "unused.json",
		canvasPath: tempDir.join("interrupted.canvas.tsx"),
		cwd: tempDir.path(),
		debounceMs: 1,
		taskTimeoutMs: 1_000,
		streamPublishMs: 1,
		streamIdleTimeoutMs: 1_000,
		initOnly: false,
		resume: false,
		semanticPreflight: false,
		reviewOnly: false,
		reviewModel: "@default",
		reviewTimeoutMs: 120_000,
	};
	const sessionStarted = Promise.withResolvers<void>();
	const releaseSession = Promise.withResolvers<void>();
	const firstExecution = executeDAG(dag, args, () =>
		Promise.resolve(
			new FakeRunnerSession(
				async () => {
					sessionStarted.resolve();
					await releaseSession.promise;
					return [{ contentText: "late success", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {},
			),
		),
	);
	await sessionStarted.promise;

	const checkpointPath = checkpointPathForCanvas(args.canvasPath);
	const runningCheckpoint = await Bun.file(checkpointPath).text();
	expect(JSON.parse(runningCheckpoint).state.tasks[0].status).toBe("RUNNING");
	releaseSession.resolve();
	await firstExecution;
	await Bun.write(checkpointPath, runningCheckpoint);

	const prompts: string[] = [];
	const resumed = await executeDAG(dag, { ...args, resume: true }, () =>
		Promise.resolve(
			new FakeRunnerSession(
				async prompt => {
					prompts.push(prompt);
					return [{ contentText: "resumed success", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				},
				() => {},
			),
		),
	);

	expect(prompts).toHaveLength(1);
	expect(prompts[0]).toContain("Previous attempt did not finish successfully");
	expect(resumed.runOutcome).toBe("SUCCESS");
	expect(resumed.tasks[0].status).toBe("FINISHED");
});

test("applies SDK agent_end finalization grace and bounds timed-out session cleanup", async () => {
	using tempDir = TempDir.createSync("@omp-dag-terminal-grace-");
	const neverFinalizes = Promise.withResolvers<RunnerAssistantMessage[]>();
	let aborted = 0;
	let disposed = 0;
	const dag = parseDAG({
		title: "Terminal grace",
		goal: "Test goal",
		success_criteria: ["Criterion"],
		tasks: [{ id: "task", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "TASK" }],
	});
	const state = await executeDAG(
		dag,
		{
			dag: "unused.json",
			canvasPath: tempDir.join("run.canvas.tsx"),
			cwd: tempDir.path(),
			debounceMs: 1,
			taskTimeoutMs: 40,
			streamPublishMs: 1,
			streamIdleTimeoutMs: 1_000,
			semanticPreflight: false,
			reviewOnly: false,
			reviewModel: "@default",
			reviewTimeoutMs: 120_000,
			initOnly: false,
			resume: false,
		},
		() =>
			Promise.resolve(
				new FakeRunnerSession(
					async (_prompt, publish) => {
						publish({ type: sdkSessionEventKind("agent_end") });
						return neverFinalizes.promise;
					},
					() => {
						disposed++;
					},
					() => {
						aborted++;
					},
				),
			),
	);

	expect(state.runOutcome).toBe("FAILED");
	expect(state.tasks[0].errorMessage).toContain("did not finalize within");
	expect(state.tasks[0].errorMessage).toContain("after stream completion");
	expect(aborted).toBe(1);
	expect(disposed).toBe(1);
});

test("disposes a session factory result that arrives after the task deadline", async () => {
	using tempDir = TempDir.createSync("@omp-dag-late-session-");
	let aborted = 0;
	let disposed = 0;
	const lateSession = new FakeRunnerSession(
		async () => [{ contentText: "unused", inputTokens: 0, outputTokens: 0, stopReason: "stop" }],
		() => {
			disposed++;
		},
		() => {
			aborted++;
		},
	);
	const dag = parseDAG({
		title: "Late session",
		goal: "Test goal",
		success_criteria: ["Criterion"],
		tasks: [{ id: "task", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "TASK" }],
	});
	const state = await executeDAG(
		dag,
		{
			dag: "unused.json",
			canvasPath: tempDir.join("run.canvas.tsx"),
			cwd: tempDir.path(),
			debounceMs: 1,
			taskTimeoutMs: 10,
			streamPublishMs: 1,
			streamIdleTimeoutMs: 1_000,
			semanticPreflight: false,
			reviewOnly: false,
			reviewModel: "@default",
			reviewTimeoutMs: 120_000,
			initOnly: false,
			resume: false,
		},
		async () => {
			await Bun.sleep(30);
			return lateSession;
		},
	);
	await Bun.sleep(40);

	expect(state.runOutcome).toBe("FAILED");
	expect(state.tasks[0].errorMessage).toBe("Task task exceeded deadline of 10ms");
	expect(aborted).toBe(1);
	expect(disposed).toBe(1);
});

describe("CLI and output parity", () => {
	test("preserves CLI defaults, suffix normalization, and unknown-flag tolerance", () => {
		const args = parseArgs(
			["--dag", "dag.json", "--canvas", "run.tsx", "--unknown", "ignored", "--init-only"],
			"/work/demo",
		);

		expect(args).toEqual({
			dag: "dag.json",
			canvasPath: `${defaultCanvasesDir("/work/demo")}/run.tsx.canvas.tsx`,
			cwd: "/work/demo",
			modelsFile: undefined,
			debounceMs: 200,
			taskTimeoutMs: 1_200_000,
			streamPublishMs: 500,
			streamIdleTimeoutMs: 300_000,
			semanticPreflight: false,
			reviewOnly: false,
			reviewModel: "@default",
			reviewTimeoutMs: 120_000,
			initOnly: true,
			resume: false,
		});
		expect(() => parseArgs(["--dag", "dag.json", "--canvas", "run", "--debounce", "0"])).toThrow(
			"--debounce must be a positive integer",
		);
		expect(parseArgs(["--dag", "dag.json", "--canvas", "run", "--resume"]).resume).toBe(true);
		expect(() => parseArgs(["--dag", "dag.json", "--canvas", "run", "--resume", "checkpoint.json"])).toThrow(
			"--resume does not accept a value",
		);
		expect(() => parseArgs(["--dag", "dag.json", "--canvas", "run", "--resume", "--init-only"])).toThrow(
			"--resume cannot be combined",
		);
	});

	test("renders the exact static Handlebars upstream prompt and caps parent output", () => {
		const task = {
			id: "child",
			depends_on: ["parent"],
			context_from: ["parent"],
			writes: [],
			complexity: "LOW" as const,
			subtask_prompt: "Do the child task.",
		};
		const parent: TaskState = {
			id: "parent",
			depends_on: [],
			context_from: [],
			writes: [],
			complexity: "LOW",
			subtask_prompt: "Parent",
			status: "FINISHED",
			model: "auto-low",
			resultText: "x".repeat(2001),
		};
		const prompt = buildTaskPrompt(task, new Map([["parent", parent]]));

		expect(prompt).toBe(
			`Upstream task results (for context — do not re-do this work):\n\n### parent [FINISHED]\n${"x".repeat(1999)}…\n\n---\n\nDo the child task.`,
		);
		expect(buildTaskPrompt({ ...task, context_from: [] }, new Map([["parent", parent]]))).toBe("Do the child task.");
	});

	test("maps resolved OMP provider failures and aborts to task errors", () => {
		expect(terminalAssistantError({ errorMessage: "quota exhausted", stopReason: "error" })).toBe("quota exhausted");
		expect(terminalAssistantError({ stopReason: "aborted" })).toBe("Run aborted");
		expect(terminalAssistantError({ stopReason: "stop" })).toBeUndefined();
	});

	test("provides auth-safe model fallback and maps SDK agent_end to terminal grace", () => {
		expect(sdkModelSelection("composer-2", "anthropic/claude")).toEqual({
			modelPattern: "@default",
			modelPatternAuthFallback: "anthropic/claude",
		});
		expect(sdkModelSelection("custom/model", "anthropic/claude")).toEqual({
			modelPattern: "custom/model",
			modelPatternAuthFallback: "anthropic/claude",
		});
		expect(sdkSessionEventKind("agent_end")).toBe("terminal");
		expect(sdkSessionEventKind("message_update")).toBe("activity");
	});

	test("retains the newest 4,000 streamed characters with the legacy prefix", () => {
		const buffer = new BoundedTextBuffer(4);
		buffer.append("abc");
		buffer.append("def");
		expect(buffer.render()).toBe("[...truncated 2 earlier chars...]\ncdef");
	});

	test("renders a self-contained canvas with inlined initial state", () => {
		const dag = parseDAG({
			title: "Canvas",
			goal: "Test goal",
			success_criteria: ["Criterion"],
			tasks: [
				{ id: "a", depends_on: [], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "A" },
				{
					id: "b",
					depends_on: ["a"],
					context_from: [],
					writes: ["README.md"],
					complexity: "LOW",
					subtask_prompt: "B",
				},
			],
		});
		const source = renderCanvasSource(initialRunState(dag, createModelResolver()));

		expect(source).toContain("const STATE: RunState = {");
		expect(source).toContain('"context_from": []');
		expect(source).toContain('"writes": [');
		expect(source).toContain("!graphEdges[i]?.carriesContext");
		expect(source).toContain("export default function DagRun()");
	});
});

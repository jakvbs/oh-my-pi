import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initialRunState, renderCanvasSource, type TaskState } from "./canvas-writer";
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
	terminalAssistantError,
} from "./index";

class FakeRunnerSession implements RunnerSession {
	readonly #listeners = new Set<(event: RunnerSessionEvent) => void>();
	readonly #run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>;
	readonly #onDispose: () => void;
	#messages: RunnerAssistantMessage[] = [];
	#streaming = false;

	constructor(
		run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>,
		onDispose: () => void,
	) {
		this.#run = run;
		this.#onDispose = onDispose;
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
			tasks: [
				{ id: "a", depends_on: [], complexity: "LOW", subtask_prompt: "A" },
				{ id: "b", depends_on: [], complexity: "MED", subtask_prompt: "B" },
				{ id: "c", depends_on: ["a", "a", "b"], complexity: "HIGH", subtask_prompt: "C" },
			],
		});

		expect(dag.title).toBe(" demo ");
		expect(dag.tasks[2].depends_on).toEqual(["a", "b"]);
		expect(computeRanks(dag).map(rank => rank.map(task => task.id))).toEqual([["a", "b"], ["c"]]);
	});

	test("rejects invalid references and cycles", () => {
		expect(() =>
			parseDAG({
				title: "bad",
				tasks: [{ id: "a", depends_on: ["missing"], complexity: "LOW", subtask_prompt: "A" }],
			}),
		).toThrow("Task a depends_on unknown id: missing");
		expect(() =>
			parseDAG({
				title: "cycle",
				tasks: [
					{ id: "a", depends_on: ["b"], complexity: "LOW", subtask_prompt: "A" },
					{ id: "b", depends_on: ["a"], complexity: "LOW", subtask_prompt: "B" },
				],
			}),
		).toThrow("Cycle detected: a -> b -> a");
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

test("executes concurrent siblings through the session adapter and cascades provider failure skips", async () => {
	using tempDir = TempDir.createSync("@omp-dag-runner-");
	const rankOneReady = Promise.withResolvers<void>();
	const rankOneStarted = new Set<string>();
	const prompts: string[] = [];
	let disposed = 0;
	let childPrompt = "";

	const dag = parseDAG({
		title: "Adapter contract",
		tasks: [
			{ id: "parent-a", depends_on: [], complexity: "LOW", subtask_prompt: "ROOT:A" },
			{ id: "parent-b", depends_on: [], complexity: "LOW", subtask_prompt: "ROOT:B" },
			{ id: "bad-parent", depends_on: [], complexity: "LOW", subtask_prompt: "ROOT:BAD" },
			{
				id: "child",
				depends_on: ["parent-a", "parent-b"],
				complexity: "MED",
				subtask_prompt: "CHILD",
			},
			{
				id: "bad-child",
				depends_on: ["bad-parent"],
				complexity: "MED",
				subtask_prompt: "BAD CHILD",
			},
			{
				id: "bad-grandchild",
				depends_on: ["bad-child"],
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
		initOnly: false,
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
			initOnly: true,
		});
		expect(() => parseArgs(["--dag", "dag.json", "--canvas", "run", "--debounce", "0"])).toThrow(
			"--debounce must be a positive integer",
		);
	});

	test("renders the exact static Handlebars upstream prompt and caps parent output", () => {
		const task = {
			id: "child",
			depends_on: ["parent"],
			complexity: "LOW" as const,
			subtask_prompt: "Do the child task.",
		};
		const parent: TaskState = {
			id: "parent",
			depends_on: [],
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
	});

	test("maps resolved OMP provider failures and aborts to task errors", () => {
		expect(terminalAssistantError({ errorMessage: "quota exhausted", stopReason: "error" })).toBe("quota exhausted");
		expect(terminalAssistantError({ stopReason: "aborted" })).toBe("Run aborted");
		expect(terminalAssistantError({ stopReason: "stop" })).toBeUndefined();
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
			tasks: [{ id: "a", depends_on: [], complexity: "LOW", subtask_prompt: "A" }],
		});
		const source = renderCanvasSource(initialRunState(dag, createModelResolver()));

		expect(source).toContain("const STATE: RunState = {");
		expect(source).toContain('"status": "PENDING"');
		expect(source).toContain("computeDAGLayout");
		expect(source).toContain("export default function DagRun()");
	});
});

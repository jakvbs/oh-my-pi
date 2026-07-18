import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { DAGValidationError, parseDAG, validateDAG } from "./dag";
import {
	executeDAG,
	parseArgs,
	type RunnerAssistantMessage,
	type RunnerSession,
	type RunnerSessionEvent,
	runCli,
	type SessionFactory,
} from "./index";
import {
	formatSemanticIssues,
	hashNormalizedDAG,
	renderSemanticReviewPrompt,
	runSemanticPreflight,
	validateSemanticReview,
	validateTerminalYieldResult,
} from "./preflight";

function sampleDag(overrides: Record<string, unknown> = {}) {
	return {
		title: "Sample",
		goal: "Deliver a reviewed tiny feature",
		success_criteria: ["Implementation lands", "Tests pass"],
		tasks: [
			{
				id: "implement",
				depends_on: [],
				context_from: [],
				writes: ["src/feature.ts"],
				complexity: "MED",
				subtask_prompt: "Implement the feature in src/feature.ts",
			},
			{
				id: "verify",
				depends_on: ["implement"],
				context_from: [],
				writes: ["src/feature.test.ts"],
				complexity: "LOW",
				subtask_prompt: "Add and run tests for src/feature.ts",
			},
		],
		...overrides,
	};
}

function yieldDetails(review: unknown) {
	return {
		status: "success",
		schemaOverridden: false,
		data: [review],
	};
}

class FakeRunnerSession implements RunnerSession {
	readonly #listeners = new Set<(event: RunnerSessionEvent) => void>();
	readonly #run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>;
	readonly #onDispose: () => void;
	readonly #onAbort: (() => void) | undefined;
	#messages: RunnerAssistantMessage[] = [];
	#streaming = false;

	constructor(
		run: (prompt: string, publish: (event: RunnerSessionEvent) => void) => Promise<RunnerAssistantMessage[]>,
		onDispose: () => void = () => {},
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

describe("deterministic DAG preflight", () => {
	test("requires goal and nonempty success_criteria", () => {
		const missingGoal = validateDAG({
			title: "t",
			success_criteria: ["ok"],
			tasks: [
				{
					id: "a",
					depends_on: [],
					context_from: [],
					writes: [],
					complexity: "LOW",
					subtask_prompt: "A",
				},
			],
		});
		expect(missingGoal.ok).toBe(false);
		expect(missingGoal.diagnostics.some(d => d.code === "INVALID_GOAL")).toBe(true);

		const blankCriteria = validateDAG({
			title: "t",
			goal: "g",
			success_criteria: ["   "],
			tasks: [
				{
					id: "a",
					depends_on: [],
					context_from: [],
					writes: [],
					complexity: "LOW",
					subtask_prompt: "A",
				},
			],
		});
		expect(blankCriteria.diagnostics.some(d => d.code === "INVALID_SUCCESS_CRITERIA")).toBe(true);

		const deduped = parseDAG({
			title: "t",
			goal: " keep ",
			success_criteria: ["one", "one", "two"],
			tasks: [
				{
					id: "a",
					depends_on: [],
					context_from: [],
					writes: [],
					complexity: "LOW",
					subtask_prompt: "A",
				},
			],
		});
		expect(deduped.goal).toBe(" keep ");
		expect(deduped.success_criteria).toEqual(["one", "two"]);
	});

	test("returns multiple deterministic errors together in stable order", () => {
		const result = validateDAG({
			title: "t",
			goal: "   ",
			success_criteria: [],
			tasks: [
				{
					id: "a",
					depends_on: ["missing"],
					context_from: ["other"],
					writes: ["../x"],
					complexity: "LOW",
					subtask_prompt: "A",
				},
				{
					id: "a",
					depends_on: [],
					context_from: [],
					writes: [],
					complexity: "LOW",
					subtask_prompt: "B",
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map(d => d.code)).toEqual([
			"INVALID_GOAL",
			"INVALID_SUCCESS_CRITERIA",
			"INVALID_WRITE_PATH",
			"DUPLICATE_ID",
		]);
		try {
			parseDAG({
				title: "t",
				goal: "   ",
				success_criteria: [],
				tasks: [
					{
						id: "a",
						depends_on: ["missing"],
						context_from: ["other"],
						writes: ["../x"],
						complexity: "LOW",
						subtask_prompt: "A",
					},
					{
						id: "a",
						depends_on: [],
						context_from: [],
						writes: [],
						complexity: "LOW",
						subtask_prompt: "B",
					},
				],
			});
			expect.unreachable("parseDAG should throw");
		} catch (error) {
			expect(error).toBeInstanceOf(DAGValidationError);
			const message = (error as DAGValidationError).message;
			expect(message.indexOf("INVALID_GOAL")).toBeLessThan(message.indexOf("INVALID_SUCCESS_CRITERIA"));
			expect(message.indexOf("INVALID_SUCCESS_CRITERIA")).toBeLessThan(message.indexOf("INVALID_WRITE_PATH"));
			expect(message.indexOf("INVALID_WRITE_PATH")).toBeLessThan(message.indexOf("DUPLICATE_ID"));
		}
	});

	test("preserves cycle, context, and write conflict diagnostics", () => {
		expect(() =>
			parseDAG({
				title: "cycle",
				goal: "g",
				success_criteria: ["c"],
				tasks: [
					{ id: "a", depends_on: ["b"], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "A" },
					{ id: "b", depends_on: ["a"], context_from: [], writes: [], complexity: "LOW", subtask_prompt: "B" },
				],
			}),
		).toThrow("Cycle detected: a -> b -> a");

		expect(() =>
			parseDAG({
				title: "context",
				goal: "g",
				success_criteria: ["c"],
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

		expect(() =>
			parseDAG({
				title: "writes",
				goal: "g",
				success_criteria: ["c"],
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
	});
});

describe("semantic review contracts", () => {
	test("stable normalized DAG hash and rendered review prompt contents", async () => {
		const dag = parseDAG(sampleDag());
		const hash = await hashNormalizedDAG(dag);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(await hashNormalizedDAG(dag)).toBe(hash);

		const prompt = renderSemanticReviewPrompt(dag, hash);
		expect(prompt).toContain(hash);
		expect(prompt).toContain(dag.goal);
		expect(prompt).toContain("1. Implementation lands");
		expect(prompt).toContain("2. Tests pass");
		expect(prompt).toContain('"id":"implement"');
		expect(prompt).toContain(JSON.stringify(dag));
	});

	test("pass permits execution while error issue blocks every task session", async () => {
		using tempDir = TempDir.createSync("@omp-dag-preflight-pass-");
		const dag = parseDAG(sampleDag());
		const hash = await hashNormalizedDAG(dag);
		const taskStarts: string[] = [];
		const purposes: string[] = [];

		const passFactory: SessionFactory = async ({ purpose }) => {
			purposes.push(purpose);
			if (purpose === "preflight") {
				return new FakeRunnerSession(async (_prompt, publish) => {
					publish({
						type: "terminal_yield",
						details: yieldDetails({ verdict: "pass", issues: [] }),
					});
					return [{ contentText: "", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				});
			}
			return new FakeRunnerSession(async prompt => {
				taskStarts.push(prompt);
				return [{ contentText: "done", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
			});
		};

		const pass = await runSemanticPreflight({
			cwd: tempDir.path(),
			dag,
			dagHash: hash,
			reviewModel: "@default",
			reviewTimeoutMs: 1_000,
			sessionFactory: passFactory,
		});
		expect(pass.review.verdict).toBe("pass");

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
				initOnly: false,
				semanticPreflight: false,
				reviewOnly: false,
				reviewModel: "@default",
				reviewTimeoutMs: 120_000,
			},
			passFactory,
		);
		expect(state.runOutcome).toBe("SUCCESS");
		expect(taskStarts.length).toBe(2);

		using tempDir2 = TempDir.createSync("@omp-dag-preflight-revise-");
		const dagPath = tempDir2.join("dag.json");
		await Bun.write(dagPath, JSON.stringify(sampleDag()));
		const canvasPath = tempDir2.join("blocked.canvas.tsx");
		let taskSessions = 0;
		const exitCode = await runCli(
			["--dag", dagPath, "--canvas-path", canvasPath, "--cwd", tempDir2.path(), "--semantic-preflight"],
			undefined,
			async () => ({
				close: () => {},
				factory: async ({ purpose }) => {
					if (purpose === "task") {
						taskSessions++;
						throw new Error("task session must not start after revise");
					}
					return new FakeRunnerSession(async (_prompt, publish) => {
						publish({
							type: "terminal_yield",
							details: yieldDetails({
								verdict: "revise",
								issues: [
									{
										severity: "error",
										code: "MISSING_STEP",
										task_id: null,
										reason: "No integration step",
										suggested_fix: "Add an integration task",
									},
								],
							}),
						});
						return [{ contentText: "", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
					});
				},
			}),
		);
		expect(exitCode).toBe(1);
		expect(taskSessions).toBe(0);
		expect(await Bun.file(canvasPath).exists()).toBe(false);
	});

	test("warning-only result permits execution", async () => {
		const review = validateSemanticReview(
			{
				verdict: "pass",
				issues: [
					{
						severity: "warning",
						code: "REDUNDANT_SERIALIZATION",
						task_id: "verify",
						reason: "Could fan out later",
						suggested_fix: "Keep as-is for now",
					},
				],
			},
			new Set(["implement", "verify"]),
		);
		expect(review.verdict).toBe("pass");
		expect(formatSemanticIssues(review.issues)).toContain("warning · REDUNDANT_SERIALIZATION · verify");
	});

	test("invalid verdict or unknown task_id fails", () => {
		expect(() =>
			validateSemanticReview(
				{
					verdict: "pass",
					issues: [
						{
							severity: "error",
							code: "MISSING_STEP",
							task_id: null,
							reason: "missing",
							suggested_fix: "add step",
						},
					],
				},
				new Set(["implement"]),
			),
		).toThrow('verdict must be "revise"');

		expect(() =>
			validateSemanticReview(
				{
					verdict: "revise",
					issues: [
						{
							severity: "warning",
							code: "MISSING_STEP",
							task_id: null,
							reason: "warn only",
							suggested_fix: "n/a",
						},
					],
				},
				new Set(["implement"]),
			),
		).toThrow('verdict must be "pass"');

		expect(() =>
			validateSemanticReview(
				{
					verdict: "pass",
					issues: [
						{
							severity: "warning",
							code: "MISSING_STEP",
							task_id: "ghost",
							reason: "bad id",
							suggested_fix: "use real id",
						},
					],
				},
				new Set(["implement"]),
			),
		).toThrow("unknown task_id: ghost");
	});

	test("missing, multiple, or malformed terminal yields fail", () => {
		expect(() => validateTerminalYieldResult(undefined, { incrementalYieldCount: 0, terminalYieldCount: 0 })).toThrow(
			"produced 0 terminal yields",
		);
		expect(() =>
			validateTerminalYieldResult(yieldDetails({ verdict: "pass", issues: [] }), {
				incrementalYieldCount: 1,
				terminalYieldCount: 1,
			}),
		).toThrow("non-terminal yields");
		expect(() =>
			validateTerminalYieldResult(
				{
					status: "success",
					data: [
						{ verdict: "pass", issues: [] },
						{ verdict: "pass", issues: [] },
					],
				},
				{ incrementalYieldCount: 0, terminalYieldCount: 1 },
			),
		).toThrow();
		expect(() =>
			validateTerminalYieldResult(
				{ status: "error", error: "nope", data: [] },
				{ incrementalYieldCount: 0, terminalYieldCount: 1 },
			),
		).toThrow("aborted");
	});

	test("reviewer timeout aborts and disposes the session", async () => {
		const dag = parseDAG(sampleDag());
		let aborted = 0;
		let disposed = 0;
		await expect(
			runSemanticPreflight({
				cwd: process.cwd(),
				dag,
				dagHash: await hashNormalizedDAG(dag),
				reviewModel: "@default",
				reviewTimeoutMs: 20,
				sessionFactory: async () =>
					new FakeRunnerSession(
						async () => {
							await Bun.sleep(100);
							return [{ contentText: "", inputTokens: 0, outputTokens: 0, stopReason: "stop" }];
						},
						() => {
							disposed++;
						},
						() => {
							aborted++;
						},
					),
			}),
		).rejects.toThrow("exceeded timeout");
		expect(aborted).toBe(1);
		expect(disposed).toBe(1);
	});
});

describe("semantic preflight CLI", () => {
	test("deterministic preflight rejects before runtime initialization", async () => {
		using tempDir = TempDir.createSync("@omp-dag-deterministic-first-");
		const dagPath = tempDir.join("invalid-dag.json");
		const canvasPath = tempDir.join("must-not-exist.canvas.tsx");
		await Bun.write(dagPath, JSON.stringify({ title: "invalid", success_criteria: [], tasks: [] }));
		let runtimeCreations = 0;

		const code = await runCli(
			["--dag", dagPath, "--canvas-path", canvasPath, "--cwd", tempDir.path()],
			undefined,
			async () => {
				runtimeCreations++;
				return {
					close: () => {},
					factory: async () => {
						throw new Error("session must not start");
					},
				};
			},
		);

		expect(code).toBe(1);
		expect(runtimeCreations).toBe(0);
		expect(await Bun.file(canvasPath).exists()).toBe(false);
	});

	test("review-only requires no canvas and creates no task session", async () => {
		using tempDir = TempDir.createSync("@omp-dag-review-only-");
		const dagPath = tempDir.join("dag.json");
		await Bun.write(dagPath, JSON.stringify(sampleDag()));
		let taskSessions = 0;
		let preflightSessions = 0;
		const code = await runCli(["--dag", dagPath, "--review-only", "--cwd", tempDir.path()], undefined, async () => ({
			close: () => {},
			factory: async ({ purpose }) => {
				if (purpose === "task") {
					taskSessions++;
					throw new Error("task session must not start");
				}
				preflightSessions++;
				return new FakeRunnerSession(async (_prompt, publish) => {
					publish({
						type: "terminal_yield",
						details: yieldDetails({ verdict: "pass", issues: [] }),
					});
					return [{ contentText: "", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
				});
			},
		}));
		expect(code).toBe(0);
		expect(preflightSessions).toBe(1);
		expect(taskSessions).toBe(0);
		expect(() => parseArgs(["--dag", dagPath, "--review-only"])).not.toThrow();
	});

	test("semantic-preflight --init-only reviews then writes only the initial canvas", async () => {
		using tempDir = TempDir.createSync("@omp-dag-review-init-");
		const dagPath = tempDir.join("dag.json");
		const canvasPath = tempDir.join("init.canvas.tsx");
		await Bun.write(dagPath, JSON.stringify(sampleDag()));
		let taskSessions = 0;
		const code = await runCli(
			[
				"--dag",
				dagPath,
				"--canvas-path",
				canvasPath,
				"--cwd",
				tempDir.path(),
				"--semantic-preflight",
				"--init-only",
			],
			undefined,
			async () => ({
				close: () => {},
				factory: async ({ purpose }) => {
					if (purpose === "task") {
						taskSessions++;
						throw new Error("task session must not start in init-only");
					}
					return new FakeRunnerSession(async (_prompt, publish) => {
						publish({
							type: "terminal_yield",
							details: yieldDetails({ verdict: "pass", issues: [] }),
						});
						return [{ contentText: "", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
					});
				},
			}),
		);
		expect(code).toBe(0);
		expect(taskSessions).toBe(0);
		expect(await Bun.file(canvasPath).exists()).toBe(true);
		expect(await Bun.file(canvasPath).text()).toContain('"status": "PENDING"');
	});

	test("review-specific CLI flags enforce stated combinations", () => {
		expect(() => parseArgs(["--dag", "d.json", "--canvas", "x", "--review-model", "m"])).toThrow(
			"require --semantic-preflight or --review-only",
		);
		expect(() => parseArgs(["--dag", "d.json", "--canvas", "x", "--review-timeout-ms", "10"])).toThrow(
			"require --semantic-preflight or --review-only",
		);
		expect(() => parseArgs(["--dag", "d.json", "--review-only", "--init-only"])).toThrow(
			"cannot be combined with --init-only",
		);
		const args = parseArgs([
			"--dag",
			"d.json",
			"--semantic-preflight",
			"--canvas",
			"run",
			"--review-model",
			"custom/model",
			"--review-timeout-ms",
			"5000",
		]);
		expect(args.semanticPreflight).toBe(true);
		expect(args.reviewModel).toBe("custom/model");
		expect(args.reviewTimeoutMs).toBe(5000);
	});

	test("end-to-end fake smoke: pass executes one task with stable hash logging", async () => {
		using tempDir = TempDir.createSync("@omp-dag-smoke-");
		const dag = sampleDag({
			tasks: [
				{
					id: "only",
					depends_on: [],
					context_from: [],
					writes: [],
					complexity: "LOW",
					subtask_prompt: "ONLY",
				},
			],
		});
		const dagPath = tempDir.join("dag.json");
		const canvasPath = tempDir.join("smoke.canvas.tsx");
		await Bun.write(dagPath, JSON.stringify(dag));
		const expectedHash = await hashNormalizedDAG(parseDAG(dag));
		const logs: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
			logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return originalWrite(chunk, ...(rest as []));
		}) as typeof process.stdout.write;
		try {
			const code = await runCli(
				["--dag", dagPath, "--canvas-path", canvasPath, "--cwd", tempDir.path(), "--semantic-preflight"],
				undefined,
				async () => ({
					close: () => {},
					factory: async ({ purpose }) => {
						if (purpose === "preflight") {
							return new FakeRunnerSession(async (_prompt, publish) => {
								publish({
									type: "terminal_yield",
									details: yieldDetails({ verdict: "pass", issues: [] }),
								});
								return [{ contentText: "", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
							});
						}
						return new FakeRunnerSession(async prompt => {
							expect(prompt).toContain("ONLY");
							return [{ contentText: "done", inputTokens: 1, outputTokens: 1, stopReason: "stop" }];
						});
					},
				}),
			);
			expect(code).toBe(0);
			expect(logs.join("")).toContain(expectedHash);
			expect(await Bun.file(canvasPath).text()).toContain('"runOutcome": "SUCCESS"');
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});

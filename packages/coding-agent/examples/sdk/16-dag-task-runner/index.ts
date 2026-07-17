import { setMaxListeners } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import Handlebars from "handlebars";
import { CanvasWriter, initialRunState, type RunState, type TaskState } from "./canvas-writer";
import {
	computeRanks,
	createModelResolver,
	type DAG,
	type ModelMapOverride,
	parseDAG,
	type RawTask,
	validateModelMap,
} from "./dag";
import taskPromptTemplate from "./prompts/task.md" with { type: "text" };

export interface CliArgs {
	dag: string;
	canvasPath: string;
	cwd: string;
	modelsFile?: string;
	debounceMs: number;
	taskTimeoutMs: number;
	streamPublishMs: number;
	streamIdleTimeoutMs: number;
	initOnly: boolean;
}

interface SessionFactoryOptions {
	cwd: string;
	model: string;
}

export interface RunnerAssistantMessage {
	contentText: string;
	errorMessage?: string;
	inputTokens: number;
	outputTokens: number;
	stopReason: AssistantMessage["stopReason"];
}

export type RunnerSessionEvent = { type: "activity" } | { type: "terminal" } | { type: "text_delta"; delta: string };

export interface RunnerSession {
	readonly isStreaming: boolean;
	abort: () => Promise<void>;
	dispose: () => Promise<void>;
	getAssistantMessages: () => RunnerAssistantMessage[];
	prompt: (text: string) => Promise<void>;
	subscribe: (listener: (event: RunnerSessionEvent) => void) => () => void;
}

export type SessionFactory = (options: SessionFactoryOptions) => Promise<RunnerSession>;

interface RunTaskOptions {
	taskTimeoutMs: number;
	streamPublishMs: number;
	streamIdleTimeoutMs: number;
}

interface ModelOverrideSources {
	dagModels: ModelMapOverride | undefined;
	fileModels: ModelMapOverride | undefined;
}

interface PromptParent {
	id: string;
	status: TaskState["status"];
	output: string;
}

export interface ExecutionObserver {
	onStateCreated: (state: RunState, writer: CanvasWriter) => void;
	onFinalized: () => void;
}

export interface SdkModelSelection {
	modelPattern: string;
	modelPatternAuthFallback: string;
}

const STREAM_CAP = 4000;
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_STREAM_PUBLISH_MS = 500;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const FINALIZATION_GRACE_MS = 15 * 1000;
const CLEANUP_TIMEOUT_MS = 1000;
const UPSTREAM_SNIPPET_CAP = 2000;
const ABORT_SIGNAL_LISTENER_LIMIT = 100;
const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
	"composer-2": "@default",
	"auto-low": "@smol",
};
const renderTaskPrompt = Handlebars.compile<{
	parents: PromptParent[];
	subtaskPrompt: string;
}>(taskPromptTemplate, { noEscape: true });

export function parseArgs(argv: string[], cwdDefault = process.cwd()): CliArgs {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else {
			args[key] = "true";
		}
	}
	if (!args.dag) throw new Error("--dag <path> is required");

	const cwd = args.cwd ?? cwdDefault;
	let canvasPath = args["canvas-path"];
	if (!canvasPath) {
		if (!args.canvas) {
			throw new Error("Provide either --canvas-path <abs-path> or --canvas <name>");
		}
		const canvasesDir = args["canvases-dir"] ?? defaultCanvasesDir(cwd);
		const stem = args.canvas.replace(/\.canvas\.tsx$/, "");
		canvasPath = path.join(canvasesDir, `${stem}.canvas.tsx`);
	}
	if (!canvasPath.endsWith(".canvas.tsx")) {
		canvasPath = `${canvasPath.replace(/\.tsx$/, "")}.canvas.tsx`;
	}

	return {
		dag: args.dag,
		canvasPath,
		cwd,
		modelsFile: args["models-file"],
		debounceMs: parsePositiveInt(args.debounce, 200, "--debounce"),
		taskTimeoutMs: parsePositiveInt(args["task-timeout-ms"], DEFAULT_TASK_TIMEOUT_MS, "--task-timeout-ms"),
		streamPublishMs: parsePositiveInt(args["stream-publish-ms"], DEFAULT_STREAM_PUBLISH_MS, "--stream-publish-ms"),
		streamIdleTimeoutMs: parsePositiveInt(
			args["stream-idle-timeout-ms"],
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
			"--stream-idle-timeout-ms",
		),
		initOnly: args["init-only"] === "true",
	};
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return value;
}

export function mergeModelOverrides({ dagModels, fileModels }: ModelOverrideSources): ModelMapOverride {
	return { ...(dagModels ?? {}), ...(fileModels ?? {}) };
}

/** Mirrors the retained Cursor Canvas path scheme so existing links and artifacts keep working. */
export function defaultCanvasesDir(cwd: string): string {
	const slug = cwd
		.replace(/^\//, "")
		.replace(/\/+$/, "")
		.split("/")
		.map(segment => segment.replace(/[^A-Za-z0-9._-]/g, "-"))
		.join("-");
	return path.join(os.homedir(), ".cursor", "projects", slug, "canvases");
}

export function buildTaskPrompt(task: RawTask, stateById: ReadonlyMap<string, TaskState>): string {
	const parents: PromptParent[] = [];
	for (const dependencyId of task.depends_on) {
		const dependency = stateById.get(dependencyId);
		if (!dependency) continue;

		const output = dependency.resultText
			? truncate(dependency.resultText, UPSTREAM_SNIPPET_CAP)
			: dependency.errorMessage
				? `(failed: ${dependency.errorMessage})`
				: "(no output)";
		parents.push({ id: dependencyId, status: dependency.status, output });
	}
	return renderTaskPrompt({ parents, subtaskPrompt: task.subtask_prompt });
}

export function sdkModelSelection(model: string, authenticatedFallback: string): SdkModelSelection {
	return {
		modelPattern: LEGACY_MODEL_ALIASES[model] ?? model,
		modelPatternAuthFallback: authenticatedFallback,
	};
}

export function sdkSessionEventKind(eventType: AgentSessionEvent["type"]): "activity" | "terminal" {
	return eventType === "agent_end" ? "terminal" : "activity";
}

export function terminalAssistantError(
	message: Pick<AssistantMessage, "errorMessage" | "stopReason">,
): string | undefined {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return message.errorMessage ?? `Run ${message.stopReason}`;
}

export async function executeDAG(
	dag: DAG,
	args: CliArgs,
	sessionFactory: SessionFactory,
	observer?: ExecutionObserver,
): Promise<RunState> {
	const modelForComplexity = createModelResolver(dag.models);
	const ranks = computeRanks(dag);
	const state = initialRunState(dag, modelForComplexity);
	const stateById = new Map(state.tasks.map(task => [task.id, task]));
	const writer = new CanvasWriter(args.canvasPath, args.debounceMs);
	let finalized = false;
	observer?.onStateCreated(state, writer);

	writeLine(`DAG "${dag.title}" — ${dag.tasks.length} tasks across ${ranks.length} rank(s)`);
	writeLine(`canvas → ${args.canvasPath}`);
	writer.schedule(structuredCloneState(state));
	await writer.flush();
	if (args.initOnly) {
		finalized = true;
		writeLine("--init-only: initial canvas written, exiting");
		observer?.onFinalized();
		return state;
	}

	try {
		for (let rankIndex = 0; rankIndex < ranks.length; rankIndex++) {
			const rank = ranks[rankIndex];
			writeLine(`rank ${rankIndex + 1}/${ranks.length}: ${rank.map(task => task.id).join(", ")}`);
			await Promise.all(
				rank.map(task => {
					const failedDependencies = task.depends_on.filter(
						dependencyId => stateById.get(dependencyId)?.status === "ERROR",
					);
					if (failedDependencies.length > 0) {
						skipTask(task, stateById, state, writer, failedDependencies);
						return Promise.resolve();
					}
					return runTask(task, stateById, state, writer, args.cwd, sessionFactory, {
						taskTimeoutMs: args.taskTimeoutMs,
						streamPublishMs: args.streamPublishMs,
						streamIdleTimeoutMs: args.streamIdleTimeoutMs,
					});
				}),
			);
		}

		state.finishedAt = Date.now();
		const errors = state.tasks.filter(task => task.status === "ERROR");
		state.runOutcome = errors.length > 0 ? "FAILED" : "SUCCESS";
		if (errors.length > 0) {
			state.runMessage = `Some tasks failed: ${errors.map(task => task.id).join(", ")}`;
		}
		writer.schedule(structuredCloneState(state));
		await writer.flush();
		finalized = true;
		writeLine(
			`done — ${state.tasks.length - errors.length}/${state.tasks.length} succeeded in ${formatMs(state.finishedAt - state.startedAt)}`,
		);
		if (errors.length > 0) writeLine(`errors: ${errors.map(task => task.id).join(", ")}`);
		return state;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await markRunTerminated(state, `Runner failed: ${message}`, "FAILED");
		writer.schedule(structuredCloneState(state));
		await writer.flush();
		finalized = true;
		throw error;
	} finally {
		if (!finalized) {
			await markRunTerminated(state, "Runner exited before finalization", "FAILED");
			writer.schedule(structuredCloneState(state));
			await writer.flush();
		}
		observer?.onFinalized();
	}
}
async function runTask(
	task: RawTask,
	stateById: Map<string, TaskState>,
	state: RunState,
	writer: CanvasWriter,
	cwd: string,
	sessionFactory: SessionFactory,
	options: RunTaskOptions,
): Promise<void> {
	const taskState = stateById.get(task.id)!;
	taskState.status = "RUNNING";
	taskState.startedAt = Date.now();
	writer.schedule(structuredCloneState(state));
	const deadline = Date.now() + options.taskTimeoutMs;
	const buffer = new BoundedTextBuffer(STREAM_CAP);
	let lastPublishAt = 0;
	let session: RunnerSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let activityGuard: ActivityGuard | undefined;

	const publishIfDue = (force = false): void => {
		const now = Date.now();
		if (!force && now - lastPublishAt < options.streamPublishMs) return;
		const text = buffer.render();
		if (text.trim()) taskState.resultText = text;
		writer.schedule(structuredCloneState(state));
		lastPublishAt = now;
	};

	try {
		const sessionPromise = sessionFactory({ cwd, model: taskState.model });
		try {
			session = await withTimeout(
				sessionPromise,
				deadline - Date.now(),
				`Task ${task.id} exceeded deadline of ${formatMs(options.taskTimeoutMs)}`,
			);
		} catch (error) {
			if (error instanceof TimeoutError) observeLateSession(sessionPromise, task.id);
			throw error;
		}
		activityGuard = new ActivityGuard(task.id, deadline, options.streamIdleTimeoutMs);
		unsubscribe = session.subscribe(event => {
			if (event.type === "terminal") {
				activityGuard?.beginFinalizationGrace();
				return;
			}
			activityGuard?.touch();
			if (event.type !== "text_delta") return;
			buffer.append(event.delta);
			publishIfDue();
		});
		activityGuard.touch();
		await Promise.race([session.prompt(buildTaskPrompt(task, stateById)), activityGuard.promise]);
		activityGuard.stop();

		const assistantMessages = session.getAssistantMessages();
		const terminalMessage = assistantMessages.at(-1);
		if (!terminalMessage) throw new Error(`Task ${task.id} completed without a result`);

		taskState.finishedAt = Date.now();
		taskState.durationMs = taskState.finishedAt - (taskState.startedAt ?? taskState.finishedAt);
		taskState.inputTokens = assistantMessages.reduce((total, message) => total + message.inputTokens, 0);
		taskState.outputTokens = assistantMessages.reduce((total, message) => total + message.outputTokens, 0);
		const rendered = buffer.render().trim();
		if (rendered) {
			taskState.resultText = rendered;
		} else {
			const terminalText = terminalMessage.contentText.trim();
			if (terminalText) taskState.resultText = terminalText;
		}

		const terminalError = terminalAssistantError(terminalMessage);
		if (terminalError) {
			taskState.status = "ERROR";
			taskState.errorMessage = terminalError;
		} else {
			taskState.status = "FINISHED";
		}
	} catch (error) {
		if (session && error instanceof TimeoutError) {
			await cleanupSession(session, task.id, true);
			session = undefined;
		}
		taskState.finishedAt = Date.now();
		taskState.durationMs = taskState.finishedAt - (taskState.startedAt ?? taskState.finishedAt);
		taskState.status = "ERROR";
		taskState.errorMessage = error instanceof Error ? error.message : String(error);
		const rendered = buffer.render().trim();
		if (rendered) taskState.resultText = rendered;
	} finally {
		activityGuard?.stop();
		unsubscribe?.();
		publishIfDue(true);
		if (session) await cleanupSession(session, task.id, false);
		writer.schedule(structuredCloneState(state));
	}
}

class ActivityGuard {
	readonly promise: Promise<never>;
	readonly #reject: (error: Error) => void;
	#timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly taskId: string,
		private readonly deadline: number,
		private readonly idleTimeoutMs: number,
	) {
		const deferred = Promise.withResolvers<never>();
		this.promise = deferred.promise;
		this.#reject = deferred.reject;
	}

	touch(): void {
		this.stop();
		const remaining = this.deadline - Date.now();
		if (remaining <= 0) {
			this.#reject(new TimeoutError(`Task ${this.taskId} exceeded deadline`));
			return;
		}
		const timeoutMs = Math.min(remaining, this.idleTimeoutMs);
		this.#timer = setTimeout(() => {
			this.#reject(new TimeoutError(streamWaitTimeoutMessage(this.taskId, timeoutMs, this.idleTimeoutMs)));
		}, timeoutMs);
	}

	beginFinalizationGrace(): void {
		this.stop();
		const remaining = this.deadline - Date.now();
		if (remaining <= 0) {
			this.#reject(new TimeoutError(`Task ${this.taskId} exceeded deadline`));
			return;
		}
		const timeoutMs = Math.min(remaining, FINALIZATION_GRACE_MS);
		this.#timer = setTimeout(() => {
			this.#reject(
				new TimeoutError(
					`Task ${this.taskId} did not finalize within ${formatMs(timeoutMs)} after stream completion`,
				),
			);
		}, timeoutMs);
	}

	stop(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
	if (timeoutMs <= 0) throw new TimeoutError(timeoutMessage);
	const deferred = Promise.withResolvers<T>();
	let timer: NodeJS.Timeout | undefined = setTimeout(
		() => deferred.reject(new TimeoutError(timeoutMessage)),
		timeoutMs,
	);
	try {
		return await Promise.race([promise, deferred.promise]);
	} finally {
		clearTimeout(timer);
		timer = undefined;
	}
}

function streamWaitTimeoutMessage(taskId: string, timeoutMs: number, idleTimeoutMs: number): string {
	const effectiveTimeout = formatMs(timeoutMs);
	if (timeoutMs < idleTimeoutMs) {
		return `Task ${taskId} produced no stream events within ${effectiveTimeout} before the task deadline (configured stream idle timeout: ${formatMs(idleTimeoutMs)})`;
	}
	return `Task ${taskId} produced no stream events within ${effectiveTimeout}`;
}

function observeLateSession(sessionPromise: Promise<RunnerSession>, taskId: string): void {
	void sessionPromise
		.then(session => cleanupSession(session, taskId, true))
		.catch(error => {
			logger.warn("DAG runner session factory rejected after its deadline", {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

async function cleanupSession(session: RunnerSession, taskId: string, forceAbort: boolean): Promise<void> {
	if (forceAbort || session.isStreaming) {
		await boundedSessionOperation(() => session.abort(), taskId, "abort");
	}
	await boundedSessionOperation(() => session.dispose(), taskId, "dispose");
}

async function boundedSessionOperation(
	operation: () => Promise<void>,
	taskId: string,
	operationName: "abort" | "dispose",
): Promise<void> {
	try {
		await withTimeout(
			operation(),
			CLEANUP_TIMEOUT_MS,
			`Task ${taskId} ${operationName} exceeded ${formatMs(CLEANUP_TIMEOUT_MS)}`,
		);
	} catch (error) {
		logger.warn(`DAG runner failed to ${operationName} task session`, {
			taskId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class BoundedTextBuffer {
	#data = "";
	#droppedChars = 0;

	constructor(private readonly cap: number) {}

	append(chunk: string): void {
		if (!chunk) return;
		this.#data += chunk;
		if (this.#data.length <= this.cap) return;
		const overflow = this.#data.length - this.cap;
		this.#droppedChars += overflow;
		this.#data = this.#data.slice(overflow);
	}

	render(): string {
		if (this.#droppedChars === 0) return this.#data;
		return `[...truncated ${this.#droppedChars} earlier chars...]\n${this.#data}`;
	}
}

function skipTask(
	task: RawTask,
	stateById: Map<string, TaskState>,
	state: RunState,
	writer: CanvasWriter,
	failedDependencies: string[],
): void {
	const taskState = stateById.get(task.id)!;
	taskState.status = "ERROR";
	taskState.finishedAt = Date.now();
	taskState.durationMs = 0;
	taskState.errorMessage = `Skipped: upstream task(s) ${failedDependencies.join(", ")} failed`;
	writeLine(`skipping ${task.id} — upstream ${failedDependencies.join(", ")} failed`);
	writer.schedule(structuredCloneState(state));
}

async function markRunTerminated(state: RunState, message: string, outcome: "FAILED" | "INTERRUPTED"): Promise<void> {
	const now = Date.now();
	state.runOutcome = outcome;
	state.runMessage = message;
	state.finishedAt = now;
	for (const task of state.tasks) {
		if (task.status === "FINISHED" || task.status === "ERROR") continue;
		task.status = "ERROR";
		task.errorMessage = outcome === "INTERRUPTED" ? "Runner interrupted" : "Runner terminated";
		task.finishedAt = now;
		task.durationMs = task.startedAt === undefined ? 0 : now - task.startedAt;
	}
}

function truncate(value: string, cap: number): string {
	if (value.length <= cap) return value;
	return `${value.slice(0, cap - 1)}…`;
}

function formatMs(milliseconds: number): string {
	if (milliseconds < 1000) return `${milliseconds}ms`;
	const seconds = milliseconds / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds - minutes * 60);
	return `${minutes}m ${remainder}s`;
}

function structuredCloneState(state: RunState): RunState {
	return structuredClone(state);
}

function writeLine(message: string): void {
	process.stdout.write(`[dag-runner] ${message}\n`);
}

class CodingAgentSessionAdapter implements RunnerSession {
	readonly #session: AgentSession;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	get isStreaming(): boolean {
		return this.#session.isStreaming;
	}

	subscribe(listener: (event: RunnerSessionEvent) => void): () => void {
		return this.#session.subscribe(event => {
			if (sdkSessionEventKind(event.type) === "terminal") {
				listener({ type: "terminal" });
				return;
			}
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				listener({ type: "text_delta", delta: event.assistantMessageEvent.delta });
				return;
			}
			listener({ type: "activity" });
		});
	}

	async prompt(text: string): Promise<void> {
		await this.#session.prompt(text, { expandPromptTemplates: false });
	}

	getAssistantMessages(): RunnerAssistantMessage[] {
		return this.#session.state.messages
			.filter(message => message.role === "assistant")
			.map(message => ({
				contentText: message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(""),
				errorMessage: message.errorMessage,
				inputTokens: message.usage.input,
				outputTokens: message.usage.output,
				stopReason: message.stopReason,
			}));
	}

	async abort(): Promise<void> {
		await this.#session.abort();
	}

	async dispose(): Promise<void> {
		await this.#session.dispose();
	}
}

async function createDefaultSessionFactory(): Promise<{ close: () => void; factory: SessionFactory }> {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) {
		authStorage.close();
		throw new Error("No authenticated models available. Configure OMP credentials before running the DAG.");
	}
	const authenticatedFallback = `${availableModels[0].provider}/${availableModels[0].id}`;

	return {
		close: () => authStorage.close(),
		factory: async ({ cwd, model }) => {
			const settings = Settings.isolated({ "retry.enabled": false });
			const modelSelection = sdkModelSelection(model, authenticatedFallback);
			const { session } = await createAgentSession({
				authStorage,
				cwd,
				disableExtensionDiscovery: true,
				enableLsp: false,
				enableMCP: false,
				hasUI: false,
				...modelSelection,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings,
			});
			return new CodingAgentSessionAdapter(session);
		},
	};
}

export async function runCli(argv = process.argv.slice(2), observer?: ExecutionObserver): Promise<number> {
	const args = parseArgs(argv);
	setMaxListeners(ABORT_SIGNAL_LISTENER_LIMIT);
	const runtime = args.initOnly ? undefined : await createDefaultSessionFactory();
	try {
		const raw = JSON.parse(await Bun.file(args.dag).text());
		const dag = parseDAG(raw);
		const fileModels = args.modelsFile
			? validateModelMap(JSON.parse(await Bun.file(args.modelsFile).text()), `--models-file ${args.modelsFile}`)
			: undefined;
		dag.models = mergeModelOverrides({ dagModels: dag.models, fileModels });

		if (args.initOnly) {
			await executeDAG(
				dag,
				args,
				async () => {
					throw new Error("Session factory must not run in --init-only mode");
				},
				observer,
			);
			return 0;
		}

		if (!runtime) throw new Error("Runner runtime was not initialized");
		const state = await executeDAG(dag, args, runtime.factory, observer);
		return state.runOutcome === "SUCCESS" ? 0 : 1;
	} finally {
		runtime?.close();
	}
}

async function main(): Promise<void> {
	let activeState: RunState | undefined;
	let activeWriter: CanvasWriter | undefined;
	let finalizing = false;

	const finalizeAndExit = async (
		exitCode: number,
		outcome: "FAILED" | "INTERRUPTED",
		message: string,
	): Promise<void> => {
		if (finalizing) return;
		finalizing = true;
		try {
			if (activeState && activeWriter) {
				await markRunTerminated(activeState, message, outcome);
				activeWriter.schedule(structuredCloneState(activeState));
				await activeWriter.flush();
			}
		} catch (error) {
			process.stderr.write(
				`[dag-runner] failed to flush canvas during shutdown: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		} finally {
			process.exit(exitCode);
		}
	};

	const onUnhandledRejection = (reason: unknown): void => {
		logger.warn("DAG runner suppressed unhandled SDK rejection", {
			error: reason instanceof Error ? reason.message : String(reason),
		});
	};
	const onUncaughtException = (error: Error): void => {
		process.stderr.write(`[dag-runner] uncaught exception: ${error.stack ?? error.message}\n`);
		void finalizeAndExit(1, "FAILED", `Runner crashed: ${error.message}`);
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		const exitCode = signal === "SIGINT" ? 130 : 143;
		process.stderr.write(`[dag-runner] received ${signal}; finalizing canvas before exit\n`);
		void finalizeAndExit(exitCode, "INTERRUPTED", `Runner interrupted by ${signal}`);
	};

	process.on("unhandledRejection", onUnhandledRejection);
	process.on("uncaughtException", onUncaughtException);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.on("SIGHUP", onSignal);
	try {
		process.exitCode = await runCli(process.argv.slice(2), {
			onStateCreated: (state, writer) => {
				activeState = state;
				activeWriter = writer;
			},
			onFinalized: () => {
				activeState = undefined;
				activeWriter = undefined;
			},
		});
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
		process.off("uncaughtException", onUncaughtException);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGHUP", onSignal);
	}
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(
			`[dag-runner] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exit(1);
	});
}

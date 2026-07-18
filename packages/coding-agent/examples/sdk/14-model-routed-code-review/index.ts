import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { shutdownAll as shutdownLspClients } from "../../../src/lsp/client";
import { authorizeContextToolCall, CONTEXT_TOOL_NAMES, MAX_CONTEXT_TOOL_CALLS } from "./context-tools";
import {
	type CliCommand,
	type HashFn,
	type PromptRunner,
	parseCliCommand,
	parsePlanArtifact,
	parseUnitReviewArtifact,
	type ReviewFailure,
	type ReviewOutcome,
	type UnitReviewArtifact,
	type ValidatedPlan,
} from "./contracts";
import {
	aggregateReview,
	type CanonicalSource,
	type Clock,
	createReviewPlan,
	reviewUnit,
	reviewUnits,
	runReview,
	type SourceLoader,
} from "./review-runner";

export type {
	HashFn,
	PlanArtifact,
	PromptRunner,
	ReviewFailure,
	ReviewOutcome,
	ReviewReport,
	RiskLevel,
	UnitReviewArtifact,
	ValidatedPlan,
	ValidatedReviewUnit,
} from "./contracts";
export type {
	AggregateReviewDeps,
	AggregateReviewRequest,
	CanonicalSource,
	Clock,
	CreateReviewPlanDeps,
	CreateReviewPlanRequest,
	ReviewUnitDeps,
	ReviewUnitRequest,
	ReviewUnitsDeps,
	ReviewUnitsRequest,
	RunReviewDeps,
	RunReviewRequest,
	SourceLoader,
} from "./review-runner";
export { aggregateReview, createReviewPlan, reviewUnit, reviewUnits, runReview };

const THINKING_LEVEL = ThinkingLevel.Medium;
const REVIEWER_CONCURRENCY = 10;

const yieldResultEnvelopeSchema = z
	.object({
		status: z.string(),
		error: z.unknown().optional(),
		schemaOverridden: z.unknown().optional(),
		data: z.unknown(),
	})
	.passthrough();
const incrementalYieldSchema = z.object({ type: z.array(z.unknown()).min(1) }).passthrough();
const readResultDetailsSchema = z.object({ resolvedPath: z.string() }).passthrough();
const planTargetFilesPeekSchema = z
	.object({
		targetFiles: z.array(z.string()).optional(),
	})
	.passthrough();

function ok<T>(value: T): ReviewOutcome<T> {
	return { ok: true, value };
}

function fail<T>(failure: ReviewFailure): ReviewOutcome<T> {
	return { ok: false, failure };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256Hash(canonical: string): string {
	return createHash("sha256").update(canonical).digest("hex");
}

function normalizeAbsolutePaths(cwd: string, paths: readonly string[]): string[] {
	return [...new Set(paths.map(pathValue => resolve(cwd, pathValue)))].sort((left, right) =>
		left.localeCompare(right),
	);
}

function systemClock(): Clock {
	return {
		now() {
			return new Date().toISOString();
		},
	};
}

function filesystemSourceLoader(): SourceLoader {
	return {
		async snapshot(paths) {
			return Promise.all(
				paths.map(async pathValue => {
					const absolutePath = resolve(pathValue);
					const content = (await fs.readFile(absolutePath, "utf8")).replace(/\r\n?/g, "\n");
					return { path: absolutePath, content } satisfies CanonicalSource;
				}),
			);
		},
	};
}

function validateTerminalYieldResult<Output>({
	details,
	incrementalYieldCount,
	resultSchema,
	terminalYieldCount,
}: {
	details: unknown;
	incrementalYieldCount: number;
	resultSchema: z.ZodType<Output>;
	terminalYieldCount: number;
}): Output {
	if (incrementalYieldCount !== 0) {
		throw new Error(`SDK session produced ${incrementalYieldCount} non-terminal yields`);
	}
	if (terminalYieldCount !== 1) {
		throw new Error(`SDK session produced ${terminalYieldCount} terminal yields`);
	}
	const result = yieldResultEnvelopeSchema.parse(details);
	if (result.status !== "success") {
		throw new Error(`SDK session aborted: ${String(result.error ?? "unknown error")}`);
	}
	const schemaOverridden = result.schemaOverridden ?? false;
	if (schemaOverridden !== false) {
		throw new Error("SDK session exhausted yield schema retries");
	}
	const [output] = z.array(resultSchema).length(1).parse(result.data);
	return resultSchema.parse(output);
}

function isIncrementalYield(details: unknown) {
	return incrementalYieldSchema.safeParse(details).success;
}

async function createSdkPromptRunner(): Promise<{ modelId: string; runPrompt: PromptRunner }> {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const available = modelRegistry.getAvailable();
	const model =
		available.find(candidate => candidate.provider === "openai-codex" && candidate.id === "gpt-5.3-codex") ??
		available[0];
	if (!model) {
		throw new Error("No authenticated model is available");
	}

	const runPrompt: PromptRunner = async ({
		contextTools,
		resultSchema,
		stage,
		systemPrompt,
		thinkingLevel = THINKING_LEVEL,
		userPrompt,
	}) => {
		const startedAt = performance.now();
		const terminalSchema = z.array(resultSchema).length(1);
		const mode = contextTools?.mode ?? "none";
		const enabled = mode !== "none";
		const audit = {
			enabled,
			maxCalls: enabled ? MAX_CONTEXT_TOOL_CALLS : 0,
			requestedCalls: 0,
			blockedCalls: 0,
			callsByTool: {} as Record<string, number>,
		};
		const contextReadPaths = new Set<string>();
		const cwd = process.cwd();
		const roots = [cwd, ...(contextTools?.roots ?? [])];
		const contextToolGuard: ExtensionFactory = api => {
			api.on("tool_call", async event => {
				if (event.toolName === "yield") return undefined;
				audit.requestedCalls += 1;
				audit.callsByTool[event.toolName] = (audit.callsByTool[event.toolName] ?? 0) + 1;
				const reason = authorizeContextToolCall({
					callCount: audit.requestedCalls,
					cwd,
					input: event.input,
					mode,
					roots,
					toolName: event.toolName,
				});
				if (!reason) return undefined;
				audit.blockedCalls += 1;
				return { block: true, reason };
			});
		};
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.enableLsp": false,
			"task.maxConcurrency": 1,
			"task.maxRecursionDepth": 1,
		});
		const { session } = await createAgentSession({
			authStorage,
			contextFiles: [],
			cwd,
			customTools: [],
			disableExtensionDiscovery: true,
			enableLsp: enabled,
			enableMCP: false,
			extensions: [contextToolGuard],
			model,
			modelRegistry,
			outputSchema: z.toJSONSchema(terminalSchema),
			preloadedCustomToolPaths: [],
			requireYieldTool: true,
			sessionManager: SessionManager.inMemory(),
			settings,
			skills: [],
			slashCommands: [],
			spawns: "",
			systemPrompt: [systemPrompt],
			thinkingLevel,
			toolNames: enabled ? [...CONTEXT_TOOL_NAMES] : [],
		});

		let terminalYieldDetails: unknown;
		let terminalYieldCount = 0;
		let incrementalYieldCount = 0;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_execution_end" || event.isError) return;
			if (event.toolName === "read") {
				const details = readResultDetailsSchema.safeParse(event.result.details);
				if (details.success) contextReadPaths.add(details.data.resolvedPath);
				return;
			}
			if (event.toolName !== "yield") return;
			if (isIncrementalYield(event.result.details)) {
				incrementalYieldCount += 1;
			} else {
				terminalYieldCount += 1;
				terminalYieldDetails = event.result.details;
			}
		});

		const executionMetadata = () => {
			const tokenUsage = {
				input: 0,
				output: 0,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			};
			for (const message of session.state.messages) {
				if (message.role !== "assistant") continue;
				tokenUsage.input += message.usage.input;
				tokenUsage.output += message.usage.output;
				tokenUsage.reasoning += message.usage.reasoningTokens ?? 0;
				tokenUsage.cacheRead += message.usage.cacheRead;
				tokenUsage.cacheWrite += message.usage.cacheWrite;
				tokenUsage.totalTokens += message.usage.totalTokens;
			}
			return {
				stage,
				durationMs: Math.round(performance.now() - startedAt),
				tokenUsage,
				contextTools: audit,
			};
		};

		try {
			await session.prompt(userPrompt);
			const output = validateTerminalYieldResult({
				details: terminalYieldDetails,
				incrementalYieldCount,
				resultSchema,
				terminalYieldCount,
			});
			return {
				output,
				execution: executionMetadata(),
				contextReadPaths: [...contextReadPaths],
			};
		} finally {
			unsubscribe();
			await session.dispose();
		}
	};

	return { modelId: `${model.provider}/${model.id}`, runPrompt };
}

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await fs.access(pathValue);
		return true;
	} catch {
		return false;
	}
}

async function writeJsonAtomic(outputPath: string, value: unknown): Promise<ReviewOutcome<string>> {
	const absolutePath = resolve(outputPath);
	const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
	let destinationClaimed = false;
	try {
		await fs.mkdir(dirname(absolutePath), { recursive: true });
		const claim = await fs.open(absolutePath, "wx");
		await claim.close();
		destinationClaimed = true;
		await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporaryPath, absolutePath);
		return ok(absolutePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		if (destinationClaimed) {
			await fs.rm(absolutePath, { force: true }).catch(() => undefined);
		}
		const code = (error as { code?: string }).code;
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message:
				code === "EEXIST"
					? `Refusing to overwrite existing output: ${absolutePath}`
					: `Failed to write JSON artifact: ${errorMessage(error)}`,
			target: absolutePath,
		});
	}
}

async function loadJsonArtifact(pathValue: string): Promise<ReviewOutcome<unknown>> {
	const absolutePath = resolve(pathValue);
	try {
		return ok(JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown);
	} catch (error) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: `Failed to load JSON artifact: ${errorMessage(error)}`,
			target: absolutePath,
		});
	}
}

async function computeSourceFingerprint(input: {
	cwd: string;
	targetFiles: readonly string[];
	sourceLoader: SourceLoader;
	hash: HashFn;
}): Promise<ReviewOutcome<string>> {
	const orderedPaths = normalizeAbsolutePaths(input.cwd, input.targetFiles);
	let snapshots: readonly CanonicalSource[];
	try {
		snapshots = await input.sourceLoader.snapshot(orderedPaths);
	} catch (error) {
		return fail({
			kind: "invalid_plan",
			reason: "path",
			message: `Failed to snapshot review targets: ${errorMessage(error)}`,
		});
	}

	const byPath = new Map<string, string>();
	for (const snapshot of snapshots) {
		byPath.set(resolve(input.cwd, snapshot.path), snapshot.content);
	}

	for (const pathValue of orderedPaths) {
		if (!byPath.has(pathValue)) {
			return fail({
				kind: "invalid_plan",
				reason: "path",
				message: `Missing canonical snapshot for target: ${pathValue}`,
				target: pathValue,
			});
		}
	}

	const canonical = JSON.stringify(
		orderedPaths.map(pathValue => ({ path: pathValue, content: byPath.get(pathValue)! })),
	);
	return ok(input.hash(canonical));
}

async function loadValidatedPlan(input: {
	planPath: string;
	cwd: string;
	roots: readonly string[];
	sourceLoader: SourceLoader;
	hash: HashFn;
}): Promise<ReviewOutcome<ValidatedPlan>> {
	const loaded = await loadJsonArtifact(input.planPath);
	if (!loaded.ok) return loaded;

	const peeked = planTargetFilesPeekSchema.safeParse(loaded.value);
	const targetFiles = peeked.success ? peeked.data.targetFiles : undefined;
	if (!targetFiles || targetFiles.length === 0) {
		return fail({
			kind: "invalid_plan",
			reason: "schema",
			message: "Plan artifact is missing targetFiles",
			target: resolve(input.planPath),
		});
	}

	const fingerprint = await computeSourceFingerprint({
		cwd: input.cwd,
		targetFiles,
		sourceLoader: input.sourceLoader,
		hash: input.hash,
	});
	if (!fingerprint.ok) return fingerprint;

	return parsePlanArtifact(loaded.value, {
		cwd: input.cwd,
		roots: [...input.roots],
		targetFiles: [...targetFiles],
		sourceFingerprint: fingerprint.value,
		hash: input.hash,
	});
}

async function loadUnitReviewArtifactsFromDirectory(input: {
	resultsDir: string;
	plan: ValidatedPlan;
	cwd: string;
	roots: readonly string[];
}): Promise<ReviewOutcome<UnitReviewArtifact[]>> {
	const absoluteDir = resolve(input.resultsDir);
	let names: string[];
	try {
		names = (await fs.readdir(absoluteDir))
			.filter(name => name.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		return fail({
			kind: "invalid_unit_result",
			reason: "schema",
			message: `Failed to read results directory: ${errorMessage(error)}`,
		});
	}

	const artifacts: UnitReviewArtifact[] = [];
	const seenUnitIds = new Set<string>();
	for (const name of names) {
		const loaded = await loadJsonArtifact(resolve(absoluteDir, name));
		if (!loaded.ok) return loaded;
		const parsed = parseUnitReviewArtifact(loaded.value, {
			cwd: input.cwd,
			roots: [...input.roots],
			plan: input.plan,
			seenUnitIds,
		});
		if (!parsed.ok) return parsed;
		seenUnitIds.add(parsed.value.unitId);
		artifacts.push(parsed.value);
	}
	return ok(artifacts);
}

function serializeFailure(failure: ReviewFailure): string {
	return `${JSON.stringify(failure, null, 2)}\n`;
}

function serializeOutput(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function rejectExistingDestinations(paths: readonly string[]): Promise<ReviewOutcome<true>> {
	for (const pathValue of paths) {
		const absolutePath = resolve(pathValue);
		if (await pathExists(absolutePath)) {
			return fail({
				kind: "invalid_plan",
				reason: "schema",
				message: `Refusing to overwrite existing output: ${absolutePath}`,
				target: absolutePath,
			});
		}
	}
	return ok(true);
}

async function dispatchCommand(input: {
	command: CliCommand;
	runPrompt: PromptRunner;
	modelId: string;
	sourceLoader: SourceLoader;
	clock: Clock;
	hash: HashFn;
}): Promise<ReviewOutcome<unknown>> {
	const cwd = process.cwd();
	const roots = [cwd];
	const { command, runPrompt, modelId, sourceLoader, clock, hash } = input;

	if (command.command === "plan") {
		const absent = await rejectExistingDestinations([command.outputPath]);
		if (!absent.ok) return absent;
		const plan = await createReviewPlan(
			{
				reviewGoal: command.reviewGoal,
				riskLevel: command.riskLevel,
				targetFiles: command.targetFiles,
				cwd,
				roots,
			},
			{
				runPrompt,
				sourceLoader,
				clock,
				hash,
				thinkingLevel: THINKING_LEVEL,
			},
		);
		if (!plan.ok) return plan;
		const written = await writeJsonAtomic(command.outputPath, plan.value);
		if (!written.ok) return written;
		return ok(plan.value);
	}

	if (command.command === "review-unit") {
		const absent = await rejectExistingDestinations([command.outputPath]);
		if (!absent.ok) return absent;
		const plan = await loadValidatedPlan({
			planPath: command.planPath,
			cwd,
			roots,
			sourceLoader,
			hash,
		});
		if (!plan.ok) return plan;
		const artifact = await reviewUnit(
			{
				plan: plan.value,
				unitId: command.unitId,
				cwd,
				roots,
			},
			{
				runPrompt,
				sourceLoader,
				hash,
				thinkingLevel: THINKING_LEVEL,
			},
		);
		const written = await writeJsonAtomic(command.outputPath, artifact);
		if (!written.ok) return written;
		return ok(artifact);
	}

	if (command.command === "review-units") {
		const destinations = command.unitIds.map(unitId => resolve(command.outputDir, `${unitId}.json`));
		const absent = await rejectExistingDestinations(destinations);
		if (!absent.ok) return absent;
		const plan = await loadValidatedPlan({
			planPath: command.planPath,
			cwd,
			roots,
			sourceLoader,
			hash,
		});
		if (!plan.ok) return plan;
		const reviewed = await reviewUnits(
			{
				plan: plan.value,
				unitIds: command.unitIds,
				cwd,
				roots,
			},
			{
				runPrompt,
				sourceLoader,
				hash,
				concurrency: REVIEWER_CONCURRENCY,
				thinkingLevel: THINKING_LEVEL,
			},
		);
		if (!reviewed.ok) return reviewed;
		for (const artifact of reviewed.value) {
			const written = await writeJsonAtomic(resolve(command.outputDir, `${artifact.unitId}.json`), artifact);
			if (!written.ok) return written;
		}
		return ok(reviewed.value);
	}

	if (command.command === "aggregate") {
		const absent = await rejectExistingDestinations([command.outputPath]);
		if (!absent.ok) return absent;
		const startedAt = clock.now();
		const plan = await loadValidatedPlan({
			planPath: command.planPath,
			cwd,
			roots,
			sourceLoader,
			hash,
		});
		if (!plan.ok) return plan;
		const unitReviews = await loadUnitReviewArtifactsFromDirectory({
			resultsDir: command.resultsDir,
			plan: plan.value,
			cwd,
			roots,
		});
		if (!unitReviews.ok) return unitReviews;
		const report = await aggregateReview(
			{
				plan: plan.value,
				unitReviews: unitReviews.value,
				cwd,
				startedAt,
			},
			{
				runPrompt,
				clock,
				modelId,
				thinkingLevel: THINKING_LEVEL,
			},
		);
		if (!report.ok) return report;
		const written = await writeJsonAtomic(command.outputPath, report.value);
		if (!written.ok) return written;
		return ok(report.value);
	}

	if (command.outputPath) {
		const absent = await rejectExistingDestinations([command.outputPath]);
		if (!absent.ok) return absent;
	}
	const report = await runReview(
		{
			reviewGoal: command.reviewGoal,
			riskLevel: command.riskLevel,
			targetFiles: command.targetFiles,
			cwd,
			roots,
		},
		{
			runPrompt,
			sourceLoader,
			clock,
			hash,
			concurrency: REVIEWER_CONCURRENCY,
			modelId,
			thinkingLevel: THINKING_LEVEL,
		},
	);
	if (!report.ok) return report;
	if (command.outputPath) {
		const written = await writeJsonAtomic(command.outputPath, report.value);
		if (!written.ok) return written;
	}
	return ok(report.value);
}

async function main(): Promise<void> {
	const parsed = parseCliCommand(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(serializeFailure(parsed.failure));
		process.exitCode = 1;
		return;
	}

	let runner: { modelId: string; runPrompt: PromptRunner };
	try {
		runner = await createSdkPromptRunner();
	} catch (error) {
		process.stderr.write(
			serializeFailure({
				kind: "invalid_plan",
				reason: "schema",
				message: errorMessage(error),
			}),
		);
		process.exitCode = 1;
		await shutdownLspClients();
		return;
	}

	try {
		const result = await dispatchCommand({
			command: parsed.value,
			runPrompt: runner.runPrompt,
			modelId: runner.modelId,
			sourceLoader: filesystemSourceLoader(),
			clock: systemClock(),
			hash: sha256Hash,
		});
		if (!result.ok) {
			process.stderr.write(serializeFailure(result.failure));
			process.exitCode = 1;
			return;
		}
		if (parsed.value.command === "run" && parsed.value.outputPath === undefined) {
			process.stdout.write(serializeOutput(result.value));
		}
	} catch (error) {
		process.stderr.write(
			serializeFailure({
				kind: "invalid_plan",
				reason: "schema",
				message: errorMessage(error),
			}),
		);
		process.exitCode = 1;
	} finally {
		await shutdownLspClients();
	}
}

if (import.meta.main) await main();

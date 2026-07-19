import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";
import { parsePlanArtifact, parseUnitReviewArtifact } from "./artifact-codec";
import { writeJsonArtifact, writeJsonArtifactDirectory } from "./artifact-store";
import type {
	HashFn,
	PromptRunner,
	ReviewFailure,
	ReviewOutcome,
	RiskLevel,
	UnitReviewArtifact,
	ValidatedPlan,
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

export type CliCommand =
	| {
			command: "plan";
			reviewGoal: string;
			riskLevel: RiskLevel;
			targetFiles: string[];
			outputPath: string;
	  }
	| {
			command: "review-unit";
			planPath: string;
			unitId: string;
			outputPath: string;
	  }
	| {
			command: "review-units";
			planPath: string;
			unitIds: string[];
			outputDir: string;
	  }
	| {
			command: "aggregate";
			planPath: string;
			resultsDir: string;
			outputPath: string;
	  }
	| {
			command: "run";
			reviewGoal: string;
			riskLevel: RiskLevel;
			targetFiles: string[];
			outputPath?: string;
	  };

const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

function normalizeAbsolutePath(cwd: string, pathValue: string) {
	return resolve(cwd, pathValue);
}

function normalizeAbsolutePaths(cwd: string, paths: readonly string[]) {
	return [...new Set(paths.map(pathValue => resolve(cwd, pathValue)))].sort((left, right) =>
		left.localeCompare(right),
	);
}

const planTargetFilesPeekSchema = z.looseObject({ targetFiles: z.array(z.string()).optional() });

const THINKING_LEVEL = ThinkingLevel.Medium;
const REVIEWER_CONCURRENCY = 10;

function ok<T>(value: T): ReviewOutcome<T> {
	return { ok: true, value };
}

function fail<T>(failure: ReviewFailure): ReviewOutcome<T> {
	return { ok: false, failure };
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await fs.access(pathValue);
		return true;
	} catch {
		return false;
	}
}

async function loadJsonArtifact(pathValue: string, artifact: "plan" | "unit_review"): Promise<ReviewOutcome<unknown>> {
	const absolutePath = resolve(pathValue);
	let content: string;
	try {
		content = await Bun.file(absolutePath).text();
	} catch (error) {
		return fail({
			kind: "artifact_io_failed",
			operation: "read",
			path: absolutePath,
			message: `Failed to read JSON artifact: ${errorMessage(error)}`,
		});
	}
	try {
		return ok(JSON.parse(content) as unknown);
	} catch (error) {
		return fail({
			kind: "invalid_artifact",
			artifact,
			reason: "json",
			path: absolutePath,
			message: `Failed to parse JSON artifact: ${errorMessage(error)}`,
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
			kind: "source_snapshot_failed",
			stage: "planner",
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
	const loaded = await loadJsonArtifact(input.planPath, "plan");
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
			kind: "artifact_io_failed",
			operation: "read",
			path: absoluteDir,
			message: `Failed to read results directory: ${errorMessage(error)}`,
		});
	}

	const artifacts: UnitReviewArtifact[] = [];
	const seenUnitIds = new Set<string>();
	for (const name of names) {
		const loaded = await loadJsonArtifact(resolve(absoluteDir, name), "unit_review");
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

export function serializeFailure(failure: ReviewFailure): string {
	return `${JSON.stringify(failure, null, 2)}\n`;
}

export function serializeOutput(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function rejectExistingDestinations(paths: readonly string[]): Promise<ReviewOutcome<true>> {
	for (const pathValue of paths) {
		const absolutePath = resolve(pathValue);
		if (await pathExists(absolutePath)) {
			return fail({
				kind: "artifact_io_failed",
				operation: "write",
				path: absolutePath,
				message: `Refusing to overwrite existing output: ${absolutePath}`,
			});
		}
	}
	return ok(true);
}

export async function dispatchCommand(input: {
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
		const written = await writeJsonArtifact(command.outputPath, plan.value);
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
		const written = await writeJsonArtifact(command.outputPath, artifact);
		if (!written.ok) return written;
		return ok(artifact);
	}

	if (command.command === "review-units") {
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
		const published = await writeJsonArtifactDirectory(
			command.outputDir,
			reviewed.value.map(artifact => ({ fileName: `${artifact.unitId}.json`, value: artifact })),
		);
		if (!published.ok) return published;
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
				sourceLoader,
				hash,
				clock,
				modelId,
				thinkingLevel: THINKING_LEVEL,
			},
		);
		if (!report.ok) return report;
		const written = await writeJsonArtifact(command.outputPath, report.value);
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
		const written = await writeJsonArtifact(command.outputPath, report.value);
		if (!written.ok) return written;
	}
	return ok(report.value);
}

export function parseRiskLevel(raw: unknown): ReviewOutcome<RiskLevel> {
	const parsed = riskLevelSchema.safeParse(raw);
	if (!parsed.success) {
		return fail({
			kind: "invalid_cli",
			message: `Invalid risk level: ${String(raw)}`,
		});
	}
	return ok(parsed.data);
}

function takeFlagValue(args: string[], flag: string, index: number): ReviewOutcome<string> {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		return fail({
			kind: "invalid_cli",
			message: `Missing required ${flag} value`,
		});
	}
	return ok(value);
}

function parseUnitIdList(raw: string): ReviewOutcome<string[]> {
	const unitIds = raw
		.split(",")
		.map(part => part.trim())
		.filter(Boolean);
	if (unitIds.length === 0) {
		return fail({
			kind: "invalid_cli",
			message: "Expected at least one unit id",
		});
	}
	const seen = new Set<string>();
	for (const unitId of unitIds) {
		const parsed = identifierSchema.safeParse(unitId);
		if (!parsed.success) {
			return fail({
				kind: "invalid_cli",
				message: `Invalid unit id: ${unitId}`,
				argument: unitId,
			});
		}
		if (seen.has(unitId)) {
			return fail({
				kind: "invalid_cli",
				message: `Duplicate unit id selection: ${unitId}`,
				argument: unitId,
			});
		}
		seen.add(unitId);
	}
	return ok(unitIds);
}

/**
 * Parse CLI argv into a typed command.
 * Paths are resolved to absolute paths; selected unit IDs are validated once.
 *
 * ```
 * plan --goal <goal> [--risk <level>] --output <plan.json> -- <file>...
 * review-unit --plan <plan.json> --unit <id> --output <unit.json>
 * review-units --plan <plan.json> --output-dir <dir> (--units id1,id2 | --unit id)...
 * aggregate --plan <plan.json> --results-dir <dir> --output <report.json>
 * run --goal <goal> [--risk <level>] [--output <report.json>] -- <file>...
 * ```
 */
export function parseCliCommand(rawArgs: string[]): ReviewOutcome<CliCommand> {
	const cwd = process.cwd();
	const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];

	let command: CliCommand["command"] | undefined;
	let reviewGoal: string | undefined;
	let riskLevel: RiskLevel = "medium";
	let outputPath: string | undefined;
	let outputDir: string | undefined;
	let planPath: string | undefined;
	let resultsDir: string | undefined;
	let unitId: string | undefined;
	const unitIds: string[] = [];
	const positional: string[] = [];

	for (let index = 0; index < args.length; ) {
		const arg = args[index];

		if (arg === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}

		if (
			!command &&
			(arg === "plan" || arg === "review-unit" || arg === "review-units" || arg === "aggregate" || arg === "run")
		) {
			command = arg;
			index += 1;
			continue;
		}

		if (arg === "--command") {
			const value = takeFlagValue(args, "--command", index);
			if (!value.ok) return value;
			if (
				value.value !== "plan" &&
				value.value !== "review-unit" &&
				value.value !== "review-units" &&
				value.value !== "aggregate" &&
				value.value !== "run"
			) {
				return fail({
					kind: "invalid_cli",
					message: `Unknown command: ${value.value}`,
				});
			}
			command = value.value;
			index += 2;
			continue;
		}

		if (arg === "--goal") {
			const value = takeFlagValue(args, "--goal", index);
			if (!value.ok) return value;
			reviewGoal = value.value;
			index += 2;
			continue;
		}

		if (arg === "--risk" || arg === "--risk-level") {
			const value = takeFlagValue(args, arg, index);
			if (!value.ok) return value;
			const parsedRisk = parseRiskLevel(value.value);
			if (!parsedRisk.ok) return parsedRisk;
			riskLevel = parsedRisk.value;
			index += 2;
			continue;
		}

		if (arg === "--output") {
			const value = takeFlagValue(args, "--output", index);
			if (!value.ok) return value;
			outputPath = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--output-dir") {
			const value = takeFlagValue(args, "--output-dir", index);
			if (!value.ok) return value;
			outputDir = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--plan") {
			const value = takeFlagValue(args, "--plan", index);
			if (!value.ok) return value;
			planPath = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--results-dir") {
			const value = takeFlagValue(args, "--results-dir", index);
			if (!value.ok) return value;
			resultsDir = normalizeAbsolutePath(cwd, value.value);
			index += 2;
			continue;
		}

		if (arg === "--unit") {
			const value = takeFlagValue(args, "--unit", index);
			if (!value.ok) return value;
			const parsed = identifierSchema.safeParse(value.value);
			if (!parsed.success) {
				return fail({
					kind: "invalid_cli",
					message: `Invalid unit id: ${value.value}`,
					argument: value.value,
				});
			}
			if (unitId !== undefined || unitIds.includes(value.value)) {
				return fail({
					kind: "invalid_cli",
					message: `Duplicate unit id selection: ${value.value}`,
					argument: value.value,
				});
			}
			unitId = value.value;
			unitIds.push(value.value);
			index += 2;
			continue;
		}

		if (arg === "--units") {
			const value = takeFlagValue(args, "--units", index);
			if (!value.ok) return value;
			const parsed = parseUnitIdList(value.value);
			if (!parsed.ok) return parsed;
			for (const id of parsed.value) {
				if (unitIds.includes(id)) {
					return fail({
						kind: "invalid_cli",
						message: `Duplicate unit id selection: ${id}`,
						argument: id,
					});
				}
				unitIds.push(id);
			}
			if (unitId === undefined && parsed.value.length === 1) unitId = parsed.value[0];
			index += 2;
			continue;
		}

		if (arg.startsWith("--")) {
			return fail({
				kind: "invalid_cli",
				message: `Unknown flag: ${arg}`,
			});
		}

		positional.push(arg);
		index += 1;
	}

	const selectedCommand = command ?? "run";

	if (selectedCommand === "review-unit") {
		if (!planPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --plan value for review-unit",
			});
		}
		if (!unitId || unitIds.length !== 1) {
			return fail({
				kind: "invalid_cli",
				message: "review-unit requires exactly one --unit <id>",
			});
		}
		if (!outputPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --output value for review-unit",
			});
		}
		return ok({
			command: "review-unit",
			planPath,
			unitId,
			outputPath,
		});
	}

	if (selectedCommand === "review-units") {
		if (!planPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --plan value for review-units",
			});
		}
		if (!outputDir) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --output-dir value for review-units",
			});
		}
		if (unitIds.length === 0) {
			return fail({
				kind: "invalid_cli",
				message: "review-units requires explicit unit ids via --unit/--units",
			});
		}
		return ok({
			command: "review-units",
			planPath,
			unitIds: [...unitIds],
			outputDir,
		});
	}

	if (selectedCommand === "aggregate") {
		if (!planPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --plan value for aggregate",
			});
		}
		if (!resultsDir) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --results-dir value for aggregate",
			});
		}
		if (!outputPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --output value for aggregate",
			});
		}
		return ok({
			command: "aggregate",
			planPath,
			resultsDir,
			outputPath,
		});
	}

	const goal = reviewGoal ?? positional[0];
	const filePaths = reviewGoal ? positional : positional.slice(1);
	if (!goal || filePaths.length === 0) {
		return fail({
			kind: "invalid_cli",
			message: "Usage requires --goal <review-goal> and at least one target file",
		});
	}

	const targetFiles = filePaths.map(pathValue => normalizeAbsolutePath(cwd, pathValue));
	const uniqueTargets = new Set(targetFiles);
	if (uniqueTargets.size !== targetFiles.length) {
		return fail({
			kind: "invalid_cli",
			message: "Duplicate review target paths",
		});
	}

	if (selectedCommand === "plan") {
		if (!outputPath) {
			return fail({
				kind: "invalid_cli",
				message: "Missing required --output value for plan",
			});
		}
		return ok({
			command: "plan",
			reviewGoal: goal,
			riskLevel,
			targetFiles,
			outputPath,
		});
	}

	return ok({
		command: "run",
		reviewGoal: goal,
		riskLevel,
		targetFiles,
		...(outputPath ? { outputPath } : {}),
	});
}

import { shutdownAll as shutdownLspClients } from "../../../src/lsp/client";
import { dispatchCommand, parseCliCommand, serializeFailure, serializeOutput } from "./cli";
import {
	createSdkPromptRunner,
	filesystemSourceLoader,
	type SdkPromptRunner,
	sha256Hash,
	systemClock,
} from "./sdk-adapter";

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
export { aggregateReview, createReviewPlan, reviewUnit, reviewUnits, runReview } from "./review-runner";

async function main() {
	const parsed = parseCliCommand(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(serializeFailure(parsed.failure));
		process.exitCode = 1;
		return;
	}

	let runner: SdkPromptRunner;
	try {
		runner = await createSdkPromptRunner();
	} catch (error) {
		process.stderr.write(
			serializeFailure({
				kind: "runtime_failed",
				stage: "initialization",
				message: error instanceof Error ? error.message : String(error),
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
				kind: "runtime_failed",
				stage: "cli",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exitCode = 1;
	} finally {
		await shutdownLspClients();
	}
}

if (import.meta.main) await main();

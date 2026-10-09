/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { Settings } from "../config/settings";
import { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { discoverAuthStorage } from "../sdk";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODELS } from "../tts";
import { selectSetupModel } from "@oh-my-pi/pi-tui/apps/setup-model-picker";

export type SetupComponent = "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["speech"];

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function resolveLocalSpeechModelId(role: "speech" | "dictation", settings: Settings, registry: ModelRegistry): string {
	const candidate = resolveRoleChain(role, settings, roleCandidatePool(role, settings, registry)).find(
		entry => entry.model.provider === "local",
	);
	if (!candidate) throw new Error(`No local model is available for the ${role} role.`);
	return candidate.model.id;
}

function buildSpeechComponents(settings: Settings, registry: ModelRegistry): SpeechComponent[] {
	const localRoleModelIds = (role: "speech" | "dictation") =>
		new Set(
			roleCandidatePool(role, settings, registry)
				.filter(model => model.provider === "local")
				.map(model => model.id),
		);
	const sttOptions = STT_MODEL_OPTIONS.filter(option => localRoleModelIds("dictation").has(option.value));
	const ttsOptions = TTS_LOCAL_MODELS.filter(model => localRoleModelIds("speech").has(model.key)).map(
		({ key, label, description }) => ({ value: key, label, description }),
	);

	return [
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(resolveLocalSpeechModelId("dictation", settings, registry)),
			status: async () => {
				const key = resolveLocalSpeechModelId("dictation", settings, registry);
				return (await isSttModelCached(key)) ? key : `${key} — not downloaded`;
			},
			pick: async () => {
				const current = resolveLocalSpeechModelId("dictation", settings, registry);
				const chosen = await selectSetupModel("Speech-to-Text model", sttOptions, current);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.setModelRole("dictation", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(resolveLocalSpeechModelId("dictation", settings, registry), progress =>
					onProgress({ stage: `Downloading ${progress.label} model`, percent: progress.percent }),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(resolveLocalSpeechModelId("speech", settings, registry)),
			status: async () => {
				const key = resolveLocalSpeechModelId("speech", settings, registry);
				return (await isTtsModelCached(key)) ? key : `${key} — model/runtime not installed`;
			},
			pick: async () => {
				const current = resolveLocalSpeechModelId("speech", settings, registry);
				const chosen = await selectSetupModel("Text-to-Speech model", ttsOptions, current);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.setModelRole("speech", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(resolveLocalSpeechModelId("speech", settings, registry), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error("Failed to download the local text-to-speech model.");
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const settings = await Settings.init({ cwd: getProjectDir() });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const registry = new ModelRegistry(authStorage, undefined, { settings });
	const components = buildSpeechComponents(settings, registry);

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold("Speech dependencies:"));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green("[ok]") : chalk.yellow("[missing]");
			console.log(`  ${mark} ${component.name}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} ready`));
			continue;
		}
		console.log(chalk.dim(`Preparing ${component.name}...`));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `Failed to set up ${component.name}`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} Speech is ready`));
	console.log(
		chalk.dim(
			`Enable speech-to-text via stt.enabled, then hold ${formatKeyHint("space")} by default to talk (remap or disable it with app.stt.pushToTalk, or bind app.stt.toggle separately); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.`,
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Run onboarding or install dependencies for optional features

${chalk.bold("Usage:")}
  ${APP_NAME} setup                     Run the onboarding wizard
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  speech    Pick and download speech-to-text and text-to-speech models

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup                  Run the onboarding wizard
  ${APP_NAME} setup speech           Pick and download the STT and TTS models
  ${APP_NAME} setup speech --check   Check if speech dependencies are available
`);
}

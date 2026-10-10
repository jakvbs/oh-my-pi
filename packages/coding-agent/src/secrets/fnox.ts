/**
 * Lazy fnox secret registration.
 *
 * fnox injects secrets into one child process (`fnox -P staging exec -- cmd`),
 * so the agent's own environment never holds them and `collectEnvSecrets`
 * cannot see them. Before a bash command runs, resolve exactly the fnox
 * profiles it can receive and register their values with the session
 * obfuscator, so anything the command prints reaches the provider as a
 * placeholder.
 *
 * Profiles are resolved only when a command needs them: the default profile
 * of a directory that has a fnox config, plus every profile a `fnox` invocation
 * in the command names. A profile behind an interactive provider (hardware key,
 * biometric unlock) cannot be resolved non-interactively and stays unregistered.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { CONNECTION_URL_PASSWORD_RE } from "./index";
import type { SecretEntry, SecretObfuscator } from "./obfuscator";

/** One set of secrets a command can receive from fnox. */
export interface FnoxRequest {
	/** Profiles in overlay order; `default` when none is named. */
	readonly profiles: readonly string[];
	/** Explicit `--config` path, resolved by fnox relative to the command cwd. */
	readonly config?: string;
}

const RESOLVING_SUBCOMMANDS = new Set(["exec", "x", "get", "export", "ex"]);
const FLAGS_WITH_VALUE = new Set(["--if-missing", "--write-profile"]);
const CONFIG_FILES = ["fnox.toml", "fnox.local.toml"];
const RESOLVE_TIMEOUT_MS = 10_000;
const MIN_SECRET_LENGTH = 8;

/** Split a shell line into simple commands of words; quoting is honoured, expansions are not. */
function simpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && i + 1 < command.length) {
			word += command[++i];
			inWord = true;
		} else if (/\s/.test(char) && char !== "\n") {
			endWord();
		} else if (";&|()\n`".includes(char) || (char === "$" && command[i + 1] === "(")) {
			endCommand();
		} else {
			word += char;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

function splitProfiles(value: string): string[] {
	return value
		.split(",")
		.map(profile => profile.trim())
		.filter(profile => profile.length > 0);
}

/**
 * Every fnox profile set the command resolves. `inheritedProfile` is the
 * agent's own `FNOX_PROFILE`, which a child fnox inherits.
 */
export function parseFnoxRequests(command: string, inheritedProfile?: string): FnoxRequest[] {
	const requests: FnoxRequest[] = [];
	for (const words of simpleCommands(command)) {
		let envProfile = inheritedProfile;
		for (const word of words) {
			const assignment = /^FNOX_PROFILE=(.*)$/.exec(word);
			if (assignment) envProfile = assignment[1];
		}
		const start = words.findIndex(word => path.basename(word) === "fnox");
		if (start === -1) continue;
		const profiles: string[] = [];
		let config: string | undefined;
		let subcommand: string | undefined;
		for (let i = start + 1; i < words.length; i++) {
			const word = words[i]!;
			if (word === "--") break;
			const inline = /^(--profile|--config)=(.*)$/.exec(word);
			if (inline) {
				if (inline[1] === "--profile") profiles.push(...splitProfiles(inline[2]!));
				else config = inline[2];
			} else if (word === "-P" || word === "--profile") {
				profiles.push(...splitProfiles(words[++i] ?? ""));
			} else if (word === "-c" || word === "--config") {
				config = words[++i];
			} else if (word.startsWith("-P") && word.length > 2) {
				profiles.push(...splitProfiles(word.slice(2)));
			} else if (FLAGS_WITH_VALUE.has(word)) {
				i++;
			} else if (!word.startsWith("-") && subcommand === undefined) {
				subcommand = word;
			}
		}
		if (subcommand === undefined || !RESOLVING_SUBCOMMANDS.has(subcommand)) continue;
		if (profiles.length === 0) profiles.push(...splitProfiles(envProfile ?? "default"));
		requests.push(config === undefined ? { profiles } : { profiles, config });
	}
	return requests;
}

/** Whether `cwd` or an ancestor has a project fnox config. */
export function hasFnoxConfig(cwd: string): boolean {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		if (CONFIG_FILES.some(name => fs.existsSync(path.join(dir, name)))) return true;
		if (path.dirname(dir) === dir) return false;
	}
}

/** Obfuscate entries for resolved fnox values, labelled by variable name. */
export function fnoxSecretEntries(request: FnoxRequest, secrets: Record<string, string>): SecretEntry[] {
	const scope = request.profiles.filter(profile => profile !== "default").join("_");
	const entries: SecretEntry[] = [];
	for (const [name, value] of Object.entries(secrets)) {
		if (typeof value !== "string") continue;
		const label = scope ? `${scope}_${name}` : name;
		const password = CONNECTION_URL_PASSWORD_RE.exec(value)?.[1];
		if (password && password.length >= MIN_SECRET_LENGTH) {
			entries.push({ type: "plain", content: password, mode: "obfuscate", friendlyName: `${label}_PASSWORD` });
		}
		if (value.length >= MIN_SECRET_LENGTH) {
			entries.push({ type: "plain", content: value, mode: "obfuscate", friendlyName: label });
		}
	}
	return entries;
}

export type FnoxResolver = (request: FnoxRequest, cwd: string) => Promise<Record<string, string> | undefined>;

/** Resolve a request with the fnox CLI, never prompting. */
export const resolveWithFnoxCli: FnoxResolver = async (request, cwd) => {
	if (!Bun.which("fnox")) return undefined;
	const args = ["fnox", "--non-interactive", "--no-color", "--if-missing", "ignore"];
	if (request.config !== undefined) args.push("--config", request.config);
	args.push("--profile", request.profiles.join(","), "export", "--format", "json", "--all");
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), RESOLVE_TIMEOUT_MS);
	try {
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return undefined;
		const parsed = JSON.parse(text) as { secrets?: Record<string, string> };
		return parsed.secrets;
	} finally {
		clearTimeout(timer);
	}
};

const registrations = new WeakMap<SecretObfuscator, Map<string, Promise<void>>>();

/**
 * Register every fnox value `command` can receive in `cwd`. Each distinct
 * (cwd, config, profiles) resolves once per obfuscator; failures are logged
 * and not retried.
 */
export async function registerFnoxSecrets(options: {
	obfuscator: SecretObfuscator;
	command: string;
	cwd: string;
	inheritedProfile?: string;
	resolve?: FnoxResolver;
}): Promise<void> {
	const { obfuscator, command, cwd, inheritedProfile, resolve = resolveWithFnoxCli } = options;
	const requests = parseFnoxRequests(command, inheritedProfile);
	if (hasFnoxConfig(cwd)) requests.push({ profiles: splitProfiles(inheritedProfile ?? "default") });
	if (requests.length === 0) return;
	let done = registrations.get(obfuscator);
	if (!done) {
		done = new Map();
		registrations.set(obfuscator, done);
	}
	const pending: Promise<void>[] = [];
	for (const request of requests) {
		const key = `${cwd}\0${request.config ?? ""}\0${request.profiles.join(",")}`;
		let registration = done.get(key);
		if (!registration) {
			registration = (async () => {
				try {
					const secrets = await resolve(request, cwd);
					if (secrets) obfuscator.addPlainSecrets(fnoxSecretEntries(request, secrets));
				} catch (error) {
					logger.debug("fnox secret registration failed", {
						cwd,
						profiles: request.profiles,
						error: String(error),
					});
				}
			})();
			done.set(key, registration);
		}
		pending.push(registration);
	}
	await Promise.all(pending);
}

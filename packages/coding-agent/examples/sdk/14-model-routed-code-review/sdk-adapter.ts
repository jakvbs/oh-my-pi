import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
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
import { authorizeContextToolCall, CONTEXT_TOOL_NAMES, MAX_CONTEXT_TOOL_CALLS } from "./context-tools";
import type { PromptRunner } from "./contracts";
import type { CanonicalSource, Clock, SourceLoader } from "./review-runner";

export type SdkPromptRunner = { modelId: string; runPrompt: PromptRunner };

const THINKING_LEVEL = ThinkingLevel.Medium;
const yieldResultEnvelopeSchema = z.looseObject({
	status: z.string(),
	error: z.unknown().optional(),
	schemaOverridden: z.unknown().optional(),
	data: z.unknown(),
});
const incrementalYieldSchema = z.looseObject({ type: z.array(z.unknown()).min(1) });
const readResultDetailsSchema = z.looseObject({ resolvedPath: z.string() });
export function sha256Hash(canonical: string): string {
	return createHash("sha256").update(canonical).digest("hex");
}

export function systemClock(): Clock {
	return {
		now() {
			return new Date().toISOString();
		},
	};
}

export function filesystemSourceLoader(): SourceLoader {
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

export async function createSdkPromptRunner(): Promise<SdkPromptRunner> {
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

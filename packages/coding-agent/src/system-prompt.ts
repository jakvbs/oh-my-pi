/**
 * System prompt construction and project context loading
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolExample, TSchema } from "@oh-my-pi/pi-ai";
import { renderToolInventory } from "@oh-my-pi/pi-ai/dialect";
import type { DelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import { $env, getAgentDir, getProjectDir, hasFsCode, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { contextFileCapability } from "./capability/context-file";
import { findConfigFile } from "./config";
import type { SkillsSettings } from "./extensibility/settings";
import { type ContextFile, loadCapability } from "./discovery";
import { expandAtImports } from "./discovery/at-imports";
import { SkillDescriptionCatalog } from "./extensibility/skill-descriptions";
import { loadSkills, type Skill } from "./extensibility/skills";
import { InternalUrlRouter } from "./internal-urls/router";
import type { SchemeHost } from "./internal-urls/types";
import activeRepoContextTemplate from "./prompts/system/active-repo-context.md" with { type: "text" };
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import harnessPromptTemplate from "./prompts/system/harness-prompt.md" with { type: "text" };
import { normalizeConcurrencyLimit } from "./task/parallel";
import type { ActiveRepoContext } from "@oh-my-pi/pi-tui/status-line/host";
import { XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { normalizePromptPath } from "./utils/prompt-path";
import { AGENTS_MD_LIMIT, buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";
import { combine } from "./config/registry";
import { cfgBashAutoBackgroundEnabled } from "./exec/settings";
import { cfgTtsrBuiltinRules, cfgTtsrDisabledRules, cfgTtsrEnabled } from "./export/ttsr-settings";
import { cfgTuiAutoGraph, cfgTuiReactions, cfgTuiRenderMermaid, cfgTuiRenderSvg } from "./modes/settings";
import { cfgSecretsEnabled } from "./secrets/settings";
import { cfgToolsFormat } from "./session/context-settings";
import { cfgIncludeModelInPrompt, cfgIncludeWorkspaceTree, cfgInlineToolDescriptors } from "./session/settings";
import { cfgTaskBatch, cfgTaskEager } from "./task/settings";
import {
	cfgAsyncEnabled,
	cfgToolsIntentTracing,
	cfgToolsXdevDocs,
	cfgToolsXdevInlineDevices,
	cfgVaultEnabled,
} from "./tools/settings";

/**
 * Settings the system prompt renders from (`secrets.enabled` via the obfuscator state it
 * reports). A session rebuilds its prompt once per coalesced change of this value, so a bulk
 * settings change rebuilds once. Settings that change the tool set, skills, memory, or workspace
 * roots rebuild through their own reconcile instead.
 */
export const cfgSystemPromptInputs = combine({
	includeModelInPrompt: cfgIncludeModelInPrompt,
	includeWorkspaceTree: cfgIncludeWorkspaceTree,
	inlineToolDescriptors: cfgInlineToolDescriptors,
	toolsFormat: cfgToolsFormat,
	intentTracing: cfgToolsIntentTracing,
	xdevDocs: cfgToolsXdevDocs,
	xdevInlineDevices: cfgToolsXdevInlineDevices,
	vaultEnabled: cfgVaultEnabled,
	renderMermaid: cfgTuiRenderMermaid,
	renderSvg: cfgTuiRenderSvg,
	autoGraph: cfgTuiAutoGraph,
	reactions: cfgTuiReactions,
	// Rendered into the bash/task tool descriptions (inline catalog) or read by
	// the prompt builder (eager/batch delegation).
	asyncEnabled: cfgAsyncEnabled,
	bashAutoBackground: cfgBashAutoBackgroundEnabled,
	taskEager: cfgTaskEager,
	taskBatch: cfgTaskBatch,
	// Rule bucketing (TTSR registrations, rulebook, always-apply) runs at rebuild time.
	ttsrEnabled: cfgTtsrEnabled,
	ttsrBuiltinRules: cfgTtsrBuiltinRules,
	ttsrDisabledRules: cfgTtsrDisabledRules,
	secretsEnabled: cfgSecretsEnabled,
});

interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = content?.trim();
	if (!normalized) return [];
	const rendered = normalizePromptBlock(normalized);
	// Split on blank-line paragraph boundaries, but not inside fenced code
	// blocks. A rule that appears only inside a fenced example in another file
	// is an example, not an instruction, so it must not count as containment.
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;
	for (const line of rendered.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			current.push(line);
			continue;
		}
		if (!inFence && line.trim() === "" && current.length > 0 && current[current.length - 1].trim() !== "") {
			const block = current.join("\n").trim();
			if (block.length > 0) blocks.push(block);
			current = [];
			continue;
		}
		current.push(line);
	}
	const tail = current.join("\n").trim();
	if (tail.length > 0) blocks.push(tail);
	return blocks;
}

/**
 * Check whether `ruleBlocks` appears as a contiguous subsequence of
 * `sourceBlocks`. Both inputs must already be normalized and split via
 * {@link splitComparablePromptBlocks}.
 */
function promptBlocksContain(sourceBlocks: string[], ruleBlocks: string[]): boolean {
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) {
		return false;
	}
	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}
	return false;
}

function renderActiveRepoContextPrompt(activeRepoContext: ActiveRepoContext | null): string {
	if (!activeRepoContext) return "";
	return prompt
		.render(activeRepoContextTemplate, {
			relativeRepoRoot: normalizePromptPath(activeRepoContext.relativeRepoRoot),
		})
		.trim();
}

const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;
/** Workstation facts the model needs to pick commands and paths: platform/release and CPU architecture. */
function getEnvironmentInfo(): Array<{ label: string; value: string }> {
	return [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Arch", value: os.arch() },
	];
}

/**
 * The user's policy block: `<agentDir>/AGENTS.md` (`~/.omp/agent/AGENTS.md` by default),
 * with `@path` includes expanded. Null when the file is absent or empty.
 */
async function loadUserPolicy(agentDir: string): Promise<string | null> {
	const filePath = path.join(agentDir, "AGENTS.md");
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const policy = (await expandAtImports(content, filePath)).trim();
	return policy || null;
}

/** Discover TITLE_SYSTEM.md file for automatic session-title prompt overrides */
export function discoverTitleSystemPromptFile(cwd?: string): string | undefined {
	const projectPath = findConfigFile("TITLE_SYSTEM.md", { user: false, cwd });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("TITLE_SYSTEM.md", { user: true, cwd });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Resolve input as file path or literal string */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) {
		return input;
	} else if (input.includes("\n")) {
		return input;
	}

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
	/** Disabled extension IDs to honor instead of the process-global settings. */
	disabledExtensions?: string[];
}

/**
 * Deduplicate context files by paragraph containment.
 *
 * Files are sorted by depth descending (farther from cwd first) so that a
 * file is omitted only when a more-authoritative (closer-to-cwd) file
 * contains its entire normalized paragraph sequence as a contiguous run.
 * This makes the function self-contained — it does not rely on callers
 * pre-sorting the array, which matters because some callers concatenate
 * independently sorted workspace roots where array position does not reflect
 * authority. Files whose paragraphs are merely paraphrased or interleaved are
 * kept — containment is exact after normalization, not fuzzy.
 *
 * @internal Exported for testing.
 */
export function dedupeContainedContextFiles(
	contextFiles: Array<{ path: string; content: string; depth?: number }>,
): Array<{ path: string; content: string; depth?: number }> {
	// Sort by depth descending: higher depth (farther from cwd, less
	// authoritative) first, lower depth (closer to cwd, more authoritative)
	// last. Stable sort preserves caller order among equal-depth files.
	const sorted = [...contextFiles].sort((a, b) => {
		const depthA = a.depth ?? Number.POSITIVE_INFINITY;
		const depthB = b.depth ?? Number.POSITIVE_INFINITY;
		return depthB - depthA;
	});
	const blocks = sorted.map(file => splitComparablePromptBlocks(file.content));
	return sorted.filter(
		(_file, index) =>
			!blocks.some(
				(candidateBlocks, candidateIndex) =>
					candidateIndex > index && promptBlocksContain(candidateBlocks, blocks[index]),
			),
	);
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability(contextFileCapability.id, {
		cwd: resolvedCwd,
		disabledExtensions: options.disabledExtensions,
	});

	// Materialize ContextFile items, expanding any `@path/to/file` includes
	// in their content. The expansion uses the file's own directory as the
	// resolution base so relative imports work the same way Claude Code,
	// Goose, and other tools document.
	const files = await Promise.all(
		result.items.map(async item => {
			const contextFile = item as ContextFile;
			return {
				path: contextFile.path,
				content: await expandAtImports(contextFile.content, contextFile.path),
				depth: contextFile.depth,
			};
		}),
	);

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return dedupeContainedContextFiles(files);
}

export const DEFAULT_SYSTEM_PROMPT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
	/** Tool name the model sees on the provider wire. Defaults to the internal tool name. */
	wireName?: string;
	/** Tool parameters schema (Zod or JSON Schema), fed to the verbose inventory renderer. */
	parameters?: TSchema;
	/** Illustrative examples rendered into the verbose inventory. */
	examples?: readonly ToolExample[];
	/** Whether this concrete tool can read `skill://` instruction content. */
	readsSkillUris?: boolean;
}

export type SystemPromptToolMetadataProjection =
	| {
			mode: "compact";
			toolNames: readonly string[];
			overrides?: Partial<Record<string, Partial<SystemPromptToolMetadata>>>;
	  }
	| {
			mode: "full";
			overrides?: Partial<Record<string, Partial<SystemPromptToolMetadata>>>;
	  };

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return projectSystemPromptToolMetadata(tools, { mode: "full", overrides });
}

/** Whether a tool can read `skill://` instruction content.
 *
 * Shared by initial prompt construction and mid-session skill notices so both
 * consult declared capability instead of the tool name. Accepts live tools
 * (`AgentTool` declares the `readsSkillUris` capability) and projected
 * metadata (`SystemPromptToolMetadata`). Accepts `undefined`/`null` (missing
 * registry/metadata entries) and returns `false` for them. */
export function toolReadsSkillUris(
	tool: Pick<AgentTool, "readsSkillUris"> | SystemPromptToolMetadata | undefined | null,
): boolean {
	return tool != null && tool.readsSkillUris === true;
}

/** Builds a mode-specific metadata snapshot for internal prompt assembly. */
export function projectSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	projection: SystemPromptToolMetadataProjection,
): Map<string, SystemPromptToolMetadata> {
	const metadata = new Map<string, SystemPromptToolMetadata>();
	const addTool = (name: string, tool: AgentTool): void => {
		const override = projection.overrides?.[name];
		const labelValue = override?.label ?? tool.label;
		const wireNameValue = override?.wireName ?? tool.customWireName;
		const metadataEntry: SystemPromptToolMetadata = {
			label: typeof labelValue === "string" ? labelValue : "",
			description: "",
			wireName: typeof wireNameValue === "string" ? wireNameValue : undefined,
		};

		if (projection.mode === "full") {
			const descriptionValue = override?.description ?? tool.description;
			metadataEntry.description = typeof descriptionValue === "string" ? descriptionValue : "";
			metadataEntry.parameters = tool.parameters;
			metadataEntry.examples = tool.examples;
		}
		if ((override?.readsSkillUris ?? toolReadsSkillUris(tool)) === true) metadataEntry.readsSkillUris = true;

		metadata.set(name, metadataEntry);
	};

	if (projection.mode === "compact") {
		for (const name of projection.toolNames) {
			const tool = tools.get(name);
			if (tool) addTool(name, tool);
		}
	} else {
		for (const [name, tool] of tools) addTool(name, tool);
	}

	return metadata;
}

export interface BuildSystemPromptOptions {
	/**
	 * Policy block text. Replaces the user's `<agentDir>/AGENTS.md`; the harness and
	 * context blocks render either way.
	 */
	systemPrompt?: string;
	/** Agent directory holding the user's `AGENTS.md` policy. Default: getAgentDir() */
	agentDir?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Generated session notices (auto-learn, MCP routes and server instructions) closing the context block. */
	appendPrompt?: string;
	/** Inline full tool descriptors in the system prompt. Default: false */
	inlineToolDescriptors?: boolean;
	/**
	 * Whether provider-native tool calling is active (no owned/in-band syntax).
	 * When true and `inlineToolDescriptors` is false, the inventory renders as a
	 * compact tool-name list; otherwise it renders the full Harmony-style
	 * `namespace functions { … }` catalog. Default: true
	 */
	nativeTools?: boolean;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute. Injected into the project prompt. */
	additionalWorkspaceRoots?: string[];
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: readonly Skill[];
	/** Session-scoped description snapshot; background cache writes apply only to the next session. */
	skillDescriptions?: SkillDescriptionCatalog;
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** When true, the Eager Tasks section uses the hard MUST/ONLY wording (`task.eager: always`) rather than the softer `preferred` nudge. */
	eagerTasksAlways?: boolean;
	/** Whether `task.batch` is enabled; selects the centralized delegation guidance's call shape. */
	taskBatch?: boolean;
	/** Effective task concurrency limit displayed in centralized delegation guidance. Zero means unlimited. */
	taskMaxConcurrency?: number;
	/** Whether IRC-backed parallel coordination can be included in delegation policy. */
	taskIrcEnabled?: boolean;
	/** Active model's delegation appetite (catalog `delegation-bias` axis); selects the Delegation section's wording. Default: `eager`. */
	delegationBias?: DelegationBias;

	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
	/** Whether the user approves `cfg://` writes for this session; gates advertising `cfg://`. */
	settingsApproval?: boolean;
	/** Active model identifier (e.g. "anthropic/claude-opus-4") surfaced in the workstation block. */
	model?: string;
	/** Whether to surface `model` in the workstation block. Default: true. */
	includeModelInPrompt?: boolean;
	/** Whether to include the workspace directory tree in the system prompt. Default: false */
	includeWorkspaceTree?: boolean;
	/** Whether Mermaid fenced blocks render as terminal ASCII diagrams. Default: true */
	renderMermaid?: boolean;
	/** Whether the reader's UI draws ```svg fences as themed images, so the prompt invites figures. Default: false */
	renderSvg?: boolean;
	/** Whether the reader's UI charts numeric Markdown tables, so the prompt routes data to tables and forbids duplicate charts. Default: false */
	autoGraph?: boolean;
	/** Whether the TUI lifts an opening emoji into a reaction badge on the user's message. Default: false */
	reactions?: boolean;
	/** Pre-resolved nested active repo context. Undefined resolves from cwd. */
	activeRepoContext?: ActiveRepoContext | null;
	/** Tools mounted under `xd://`; renders the protocol section when non-empty. `dynamic` marks external devices whose summary is third-party metadata. */
	xdevTools?: Array<{ name: string; summary: string; dynamic?: boolean }>;
	/** Full docs + JSON schema for every `xd://`-mounted tool, inlined into the protocol section so no discovery `read` is needed. */
	xdevDocs?: string;
	/** Whether Auto-QA grievance reporting is enabled; renders the `xd://report_issue` note. */
	autoQaEnabled?: boolean;
	/** Whether active `write` is restricted to xd:// dispatch and the plan artifact sandbox. */
	writeTransportOnly?: boolean;
}

/** Result of building provider-facing system prompt messages. */
export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
	/**
	 * Names of `xd://` devices whose catalog/protocol section this prompt renders.
	 * Empty/undefined when no catalog was emitted (no mounted devices, or a custom
	 * prompt template that omits the section). Lets the session fold these devices
	 * into its announced-mount baseline so a same-turn mount notice does not re-list
	 * a catalog the prompt already carries (issue #7139).
	 */
	xdevCatalogNames?: readonly string[];
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return { systemPrompt: [] };
	}

	const {
		systemPrompt: providedPolicy,
		agentDir = getAgentDir(),
		appendPrompt,
		tools,
		inlineToolDescriptors: providedInlineToolDescriptors,
		nativeTools = true,
		skillsSettings,
		toolNames: providedToolNames,
		cwd,
		additionalWorkspaceRoots = [],
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
		alwaysApplyRules,
		intentField,
		eagerTasks = false,
		eagerTasksAlways = false,
		taskBatch = true,
		taskMaxConcurrency = 0,
		taskIrcEnabled = false,
		secretsEnabled = false,
		workspaceTree: providedWorkspaceTree,
		delegationBias = "eager",
		settingsApproval = false,
		model,
		includeModelInPrompt = true,
		includeWorkspaceTree = false,
		renderMermaid = true,
		renderSvg = false,
		autoGraph = false,
		reactions = false,
		xdevTools = [],
		xdevDocs = "",
		autoQaEnabled = false,
		writeTransportOnly = false,
		activeRepoContext: providedActiveRepoContext,
	} = options;
	const inlineToolDescriptors = providedInlineToolDescriptors ?? false;
	const resolvedCwd = cwd ?? getProjectDir();
	const prepDefaults = {
		policy: null as string | null,
		contextFiles: dedupeContainedContextFiles(providedContextFiles ?? []),
		skills: providedSkills ?? ([] as Skill[]),
		workspaceTree: {
			rootPath: resolvedCwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		} satisfies WorkspaceTree,
		activeRepoContext: null as ActiveRepoContext | null,
	};

	const { promise: deadline, resolve: fireDeadline } = Promise.withResolvers<"__timeout__">();
	const deadlineTimer = setTimeout(() => fireDeadline("__timeout__"), SYSTEM_PROMPT_PREP_TIMEOUT_MS);
	// Unref so a fast prep does not hold a one-shot CLI alive waiting for this timer.
	deadlineTimer.unref();
	const timedOut: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];

	async function withDeadline<T>(name: string, work: Promise<T>, fallback: T): Promise<T> {
		const tagged = work
			.then(value => ({ kind: "ok" as const, value }))
			.catch(error => ({ kind: "err" as const, error }));
		const result = await Promise.race([tagged, deadline]);
		if (result === "__timeout__") {
			timedOut.push(name);
			// Let the work continue in the background so its caches still warm; just log on completion.
			void tagged.then(r => {
				if (r.kind === "err") {
					logger.warn("Background system prompt preparation step failed", { name, error: String(r.error) });
				} else {
					logger.debug("Background system prompt preparation step completed after timeout", { name });
				}
			});
			return fallback;
		}
		if (result.kind === "err") {
			failed.push({ name, error: result.error });
			return fallback;
		}
		return result.value;
	}

	const contextFilesPromise = (async () => {
		const primary = providedContextFiles
			? providedContextFiles
			: await logger.time("loadProjectContextFiles", loadProjectContextFiles, { cwd: resolvedCwd });
		// Also discover context files (AGENTS.md, rules, etc.) for each additional workspace root.
		const additionalRoots = additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd));
		if (additionalRoots.length === 0) return primary;
		const extra = await Promise.all(
			additionalRoots.map(root => loadProjectContextFiles({ cwd: root }).catch(() => [])),
		);
		return dedupeContainedContextFiles([...primary, ...extra.flat()]);
	})();
	const additionalRootsForTree = additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd));
	// The scan runs even when the tree is not rendered: its AGENTS.md index feeds
	// <dir-context>, and only the rendered tree churns the prompt cache.
	const workspaceTreePromise = (async () => {
		const primary =
			providedWorkspaceTree !== undefined
				? await Promise.resolve(providedWorkspaceTree)
				: await logger.time("buildWorkspaceTree", () =>
						buildWorkspaceTree(resolvedCwd, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }),
					);
		if (additionalRootsForTree.length === 0) return primary;
		const extraTrees = await Promise.all(
			additionalRootsForTree.map(root =>
				buildWorkspaceTree(root, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }).catch(() => ({
					rootPath: root,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				})),
			),
		);
		return { ...primary, agentsMdFiles: [...primary.agentsMdFiles, ...extraTrees.flatMap(t => t.agentsMdFiles)] };
	})();
	const skillsPromise: Promise<readonly Skill[]> =
		providedSkills !== undefined
			? Promise.resolve(providedSkills)
			: skillsSettings?.enabled !== false
				? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).then(result => result.skills)
				: Promise.resolve([]);
	const activeRepoContextPromise =
		providedActiveRepoContext !== undefined
			? Promise.resolve(providedActiveRepoContext)
			: logger.time("resolveActiveRepoContext", () => resolveActiveRepoContext(resolvedCwd));
	const [policy, contextFiles, skills, workspaceTree, activeRepoContext] = await Promise.all([
		withDeadline(
			"loadUserPolicy",
			providedPolicy !== undefined ? Promise.resolve(providedPolicy.trim() || null) : loadUserPolicy(agentDir),
			prepDefaults.policy,
		),
		withDeadline("loadProjectContextFiles", contextFilesPromise, prepDefaults.contextFiles).then(
			dedupeContainedContextFiles,
		),
		withDeadline("loadSkills", skillsPromise, prepDefaults.skills),
		withDeadline("buildWorkspaceTree", workspaceTreePromise, prepDefaults.workspaceTree),
		withDeadline("resolveActiveRepoContext", activeRepoContextPromise, prepDefaults.activeRepoContext),
	]);
	clearTimeout(deadlineTimer);
	const agentsMdFiles = Array.from(new Set(workspaceTree.agentsMdFiles)).sort().slice(0, AGENTS_MD_LIMIT);

	if (timedOut.length > 0) {
		logger.warn("System prompt preparation steps timed out; using minimal fallback for those steps", {
			cwd: resolvedCwd,
			timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS,
			steps: timedOut,
		});
		process.stderr.write(
			`Warning: system prompt preparation steps timed out after ${SYSTEM_PROMPT_PREP_TIMEOUT_MS}ms (${timedOut.join(", ")}); using minimal fallback for those steps.\n`,
		);
	}
	if (failed.length > 0) {
		for (const { name, error } of failed) {
			logger.warn("System prompt preparation step failed; using minimal fallback", {
				cwd: resolvedCwd,
				step: name,
				error: String(error),
			});
		}
	}

	const promptCwd = normalizePromptPath(resolvedCwd);
	const activeRepoContextPrompt = renderActiveRepoContextPrompt(activeRepoContext);

	// Build tool metadata for system prompt rendering.
	// Priority: explicit list > tools map > conservative SDK fallback.
	let toolNames = providedToolNames;
	if (!toolNames) {
		toolNames = tools ? Array.from(tools.keys()) : [...DEFAULT_SYSTEM_PROMPT_TOOL_NAMES];
	}

	// List mode shows a compact tool-name list; it only applies when descriptors
	// stay in provider-native tool schemas AND native tool calling is active.
	// Otherwise render the full functions-namespace catalog in the system prompt.
	const toolListMode = !inlineToolDescriptors && nativeTools;
	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	// xd://-mounted tools count as present for prompt gates ({{#has tools "lsp"}})
	// and resolve to their `xd://<name>` URL, the only way to reach them. The
	// Tool Inventory list stays limited to real defs.
	for (const mounted of xdevTools) {
		if (!toolPromptNames.has(mounted.name)) toolPromptNames.set(mounted.name, `${XD_URL_PREFIX}${mounted.name}`);
	}
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	const xdevToolNames = new Set(xdevTools.map(mounted => mounted.name));
	// A direct custom tool can share a name with a retained built-in device.
	// Presence in both toolNames and tools proves it still has a top-level definition.
	const inventoryToolNames =
		xdevToolNames.size === 0 ? toolNames : toolNames.filter(name => tools?.has(name) || !xdevToolNames.has(name));
	const toolInfo = inventoryToolNames.map(name => ({
		name: toolPromptNames.get(name) ?? name,
		internalName: name,
		label: tools?.get(name)?.label ?? "",
	}));
	const toolInventory = toolListMode
		? ""
		: renderToolInventory(
				inventoryToolNames.map(name => {
					const meta = tools?.get(name);
					return {
						name: toolPromptNames.get(name) ?? name,
						description: meta?.description ?? "",
						parameters: meta?.parameters ?? ({ type: "object" } as TSchema),
						examples: meta?.examples,
					};
				}),
			);

	// Filter skills for the rendered system prompt:
	// - require an active tool that declares `skill://` read capability (any tool
	//   name, not just `read`, so custom resolvers count once projected; mounted
	//   xd:// tools count too when their metadata is projected);
	// - drop skills with frontmatter `hide: true` (still loadable via skill:// and /skill:<name>).
	const hasSkillReader =
		tools === undefined
			? toolNames.includes("read")
			: toolNames.some(name => toolReadsSkillUris(tools.get(name))) ||
				xdevTools.some(entry => toolReadsSkillUris(tools.get(entry.name)));
	const hasSkillUriAccess = hasSkillReader && skills.length > 0;
	const schemeHost: SchemeHost = {
		skillUriAccess: hasSkillUriAccess,
		ruleCount: rules?.length ?? 0,
		settingsApproval,
	};
	const filteredSkills = (options.skillDescriptions ?? new SkillDescriptionCatalog()).render(
		hasSkillReader ? skills.filter(skill => skill.hide !== true) : [],
	);

	const environment = getEnvironmentInfo();
	const data = {
		appendPrompt: appendPrompt ?? "",
		tools: [...new Set([...toolNames, ...xdevTools.map(mounted => mounted.name)])],
		toolInfo,
		toolInventory,
		inlineToolDescriptors,
		toolListMode,
		toolRefs,
		environment,
		contextFiles,
		agentsMdSearch: { files: agentsMdFiles },
		workspaceTree,
		hasSkillUriAccess,
		internalUrls: InternalUrlRouter.instance().describe(schemeHost),
		skills: filteredSkills,
		rules: rules ?? [],
		alwaysApplyRules: alwaysApplyRules ?? [],
		cwd: promptCwd,
		additionalWorkspaceRoots: additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd)),
		model: includeModelInPrompt ? (model ?? "") : "",
		delegationBias,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		eagerTasks,
		eagerTasksAlways,
		// Restrained bias yields to an explicit eager-tasks mode.
		inlineFirstDelegation: delegationBias === "restrained" && !eagerTasks,
		taskBatch,
		MAX_CONCURRENCY: normalizeConcurrencyLimit(taskMaxConcurrency),
		taskIrcEnabled,
		secretsEnabled,
		includeWorkspaceTree,
		renderMermaid,
		renderSvg,
		autoGraph,
		reactions,
		xdevTools,
		hasDynamicXdevTools: xdevTools.some(mounted => mounted.dynamic === true),
		xdevDocs,
		autoQaEnabled,
		writeTransportOnly,
	};
	const harness = prompt.render(harnessPromptTemplate, data);
	// Ordered most to least stable so provider prefix caches cover the harness
	// across sessions and the policy across directories.
	const context = prompt.render(projectPromptTemplate, { ...data, activeRepoContext: activeRepoContextPrompt }).trim();
	const systemPrompt = [harness, ...(policy ? [policy] : []), context];
	const xdevCatalogNames = xdevTools.length > 0 ? xdevTools.map(mounted => mounted.name) : undefined;
	return { systemPrompt, xdevCatalogNames };
}

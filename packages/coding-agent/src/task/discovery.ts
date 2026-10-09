/**
 * Agent discovery from filesystem.
 *
 * Agents are TypeScript modules whose default export is an `AgentSpec`:
 *   - ~/.omp/agent/agents/*.ts (user-level)
 *   - .omp/agents/*.ts (project-level)
 *   - <ext>/agents/*.ts for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { parseAgentModule } from "./agents";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentDefinition } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Agent directories searched, in precedence order (for "unknown agent" diagnostics). */
	searchedDirs?: string[];
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir({ dir, source }: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".ts"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(async file => {
			const filePath = path.join(dir, file.name);
			try {
				return parseAgentModule(filePath, await importAgentModule(filePath), source);
			} catch (error) {
				logger.warn("Failed to load agent file", { filePath, error });
				return null;
			}
		});

	return (await Promise.all(files)).filter((agent): agent is AgentDefinition => agent !== null);
}

/**
 * Bun caches `import()` per specifier for the process lifetime, while discovery
 * reruns at every spawn so edited agents apply without a restart. The mtime
 * query rekeys the entry module; modules it imports stay cached.
 */
async function importAgentModule(filePath: string): Promise<unknown> {
	const { mtimeMs } = await fs.stat(filePath);
	return (await import(`${filePath}?mtime=${mtimeMs}`)).default;
}

/**
 * Discover agents from the filesystem.
 * Precedence (highest wins): project `.omp/agents`, user `.omp/agents`,
 * OMP extension-package agents from the effective `extensions` setting,
 * then installed npm/link plugins.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for extension discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return {
		agents: loadedAgents,
		projectAgentsDir,
		searchedDirs: orderedDirs.map(entry => entry.dir),
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}

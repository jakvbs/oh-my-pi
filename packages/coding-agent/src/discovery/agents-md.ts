/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 */
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { LoadContext, LoadResult } from "../capability/types";
import { loadStandaloneContextFiles } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

/**
 * Load standalone AGENTS.md files by walking up from cwd
 * (see {@link loadStandaloneContextFiles}).
 */
export async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	return loadStandaloneContextFiles(ctx, PROVIDER_ID, "AGENTS.md");
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files",
	priority: 10,
	load: loadAgentsMd,
});

#!/usr/bin/env bun

/**
 * Fails while package sources name another agent harness's config path or
 * env var. The fork discovers only `.omp`, `.agents`, `AGENTS.md`, root
 * `mcp.json`, and installed plugins; an upstream merge or a copied upstream
 * example would otherwise quietly start importing Claude Code, Codex, Gemini,
 * OpenCode, Cursor, Windsurf, Cline, or Copilot configuration again.
 */

import { $ } from "bun";

const FOREIGN_CONFIG =
	'"\\.(claude|codex|gemini|cursor|windsurf|opencode|clinerules|cursorrules|windsurfrules|claude\\.json)"|"(CLAUDE|GEMINI)\\.md"|"copilot-instructions\\.md"|"opencode\\.jsonc?"|CLAUDE_CONFIG_DIR|CODEX_HOME|COPILOT_HOME|COPILOT_CUSTOM_INSTRUCTIONS_DIRS';

const result = await $`git grep -n -E ${FOREIGN_CONFIG} -- packages/*/src`.nothrow().quiet();
if (result.exitCode > 1) throw new Error(result.stderr.toString());
const hits = result.stdout.toString().trim();
if (hits) {
	console.error("These sources name another agent harness's config path or env var:");
	console.error(hits);
	console.error(
		"Read config only through the native `.omp` helpers (`getConfigDirs`, `getProjectAgentDir`) or the `agents` provider; delete the foreign path instead of gating it.",
	);
	process.exit(1);
}

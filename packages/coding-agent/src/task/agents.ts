import { type } from "@oh-my-pi/omptype";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import { normalizeToolNames } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";

// Undeclared keys fail: a misspelled `mcp`/`skills` would otherwise widen the agent to every server/skill.
const agentModuleSchema = type({
	"+": "reject",
	name: "string",
	description: "string",
	systemPrompt: "string",
	"tools?": "string[]",
	"model?": "string | string[]",
	"thinkingLevel?": "string",
	"cwd?": "string",
	"skills?": "string[]",
	"mcp?": "string[]",
});

/** Parse the default export of a TypeScript agent module (`AgentSpec`). */
export function parseAgentModule(filePath: string, exported: unknown, source: AgentSource): AgentDefinition {
	const spec = agentModuleSchema(exported);
	if (spec instanceof type.errors) throw new Error(`${filePath}: ${spec.summary}`);

	// "main"/"sub" are the rule-scoping sentinels for the root session and an
	// unnamed subagent; an agent named either would load rules meant only for them.
	const normalizedName = spec.name.trim().toLowerCase();
	if (
		!spec.name ||
		!spec.description ||
		normalizedName === MAIN_AGENT_RULE_NAME ||
		normalizedName === SUB_AGENT_RULE_NAME
	) {
		throw new Error(`${filePath}: reserved or empty agent name or description`);
	}

	const tools = spec.tools && normalizeToolNames(spec.tools);
	const models = (typeof spec.model === "string" ? [spec.model] : (spec.model ?? []))
		.map(entry => entry.trim())
		.filter(Boolean);
	return {
		name: spec.name,
		description: spec.description,
		systemPrompt: spec.systemPrompt,
		// Subagents finish through `yield`, so an explicit tool list always carries it.
		tools: tools && (tools.includes("yield") ? tools : [...tools, "yield"]),
		model: models.length > 0 ? models : undefined,
		thinkingLevel: parseConfiguredThinkingLevel(spec.thinkingLevel),
		cwd: spec.cwd,
		skills: spec.skills,
		mcp: spec.mcp,
		source,
		filePath,
	};
}

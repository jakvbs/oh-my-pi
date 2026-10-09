import { type } from "@oh-my-pi/omptype";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import { parseAgentFields } from "../discovery/helpers";
import type { AgentDefinition } from "./types";

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	override toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/** Parse an agent from markdown with frontmatter. */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

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
	if (spec instanceof type.errors) {
		throw new AgentParsingError(new Error(`${filePath}: ${spec.summary}`), filePath);
	}
	const fields = parseAgentFields({
		name: spec.name,
		description: spec.description,
		tools: spec.tools,
		model: spec.model,
		thinkingLevel: spec.thinkingLevel,
	});
	if (!fields) {
		throw new AgentParsingError(new Error(`${filePath}: reserved or empty agent name`), filePath);
	}
	return {
		...fields,
		systemPrompt: spec.systemPrompt,
		cwd: spec.cwd,
		skills: spec.skills,
		mcp: spec.mcp,
		source,
		filePath,
	};
}

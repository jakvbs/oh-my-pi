import { createAgentSession, type SessionAgentDefinition, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import mainPrompt from "./prompts/main.md" with { type: "text" };
import researcherPrompt from "./prompts/researcher.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };

type NonEmptyArray<T> = readonly [T, ...T[]];

const subagents = [
	{
		name: "scoped-researcher",
		description: "Read-only repository researcher that gathers implementation evidence",
		tools: ["read", "grep", "glob"],
		model: ["@smol"],
		systemPrompt: researcherPrompt,
	},
	{
		name: "scoped-reviewer",
		description: "Read-only reviewer that checks evidence and identifies material risks",
		tools: ["read", "grep"],
		model: ["@smol"],
		systemPrompt: reviewerPrompt,
	},
] satisfies NonEmptyArray<SessionAgentDefinition>;

const agentNames = subagents.map(definition => definition.name);
const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDefinitions: subagents,
	spawns: agentNames.join(","),
	sessionManager: SessionManager.inMemory(),
	settings: Settings.isolated({
		"task.maxRecursionDepth": 1,
	}),
	toolNames: ["read", "task"],
	enableMCP: false,
	disableExtensionDiscovery: true,
});

process.stdout.write(`Available subagents: ${agentNames.join(", ")}\n\n`);
const unsubscribe = session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
try {
	await session.prompt(mainPrompt.trim());
} finally {
	unsubscribe();
	await session.dispose();
}

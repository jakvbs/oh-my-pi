import type { AgentHubRegistry } from "./agent-hub-types";

export function getRunningSubagentBadgeAgentIds(registry: AgentHubRegistry): string[] {
	return registry
		.list()
		.filter(ref => ref.kind === "sub" && ref.status === "running")
		.map(ref => ref.id);
}

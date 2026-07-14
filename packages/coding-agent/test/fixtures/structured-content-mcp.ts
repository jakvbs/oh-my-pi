#!/usr/bin/env bun
import * as readline from "node:readline";

export const TOOL_NAME = "inspect_graph";
export const STRUCTURED_RESULT = { answer: 42, source: "stdio-fixture" };

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "structured-content-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call":
			return { content: [], structuredContent: STRUCTURED_RESULT };
		default:
			return {};
	}
}

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const request = JSON.parse(line) as JsonRpcRequest;
		if (request.id === undefined || request.id === null) return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: buildResult(request.method) })}\n`,
		);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) startServer();

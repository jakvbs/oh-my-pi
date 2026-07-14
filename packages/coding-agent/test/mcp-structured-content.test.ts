import { describe, expect, it } from "bun:test";
import { connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { STRUCTURED_RESULT, TOOL_NAME } from "./fixtures/structured-content-mcp";

const fixturePath = `${import.meta.dir}/fixtures/structured-content-mcp.ts`;

describe("MCP structured content over stdio", () => {
	it("delivers structured-only tool output to the model-facing result", async () => {
		const connection = await connectToServer("structured-content", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
		});

		try {
			const definitions = await listTools(connection);
			expect(definitions).toHaveLength(1);
			expect(definitions[0]?.name).toBe(TOOL_NAME);
			const tool = new MCPTool(connection, definitions[0]!);

			const result = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);

			expect(result.content).toEqual([{ type: "text", text: JSON.stringify(STRUCTURED_RESULT, null, 2) }]);
		} finally {
			await disconnectServer(connection);
		}
	});
});

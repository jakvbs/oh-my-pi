import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { BEDROCK_TEST_CONTEXT, bedrockEvent, bedrockTestModel } from "./helpers/bedrock-stream";

const raw = '{"path":"repaired.txt","content":"hello';
const tool = { name: "write", description: "Write a file", parameters: { type: "object" } };

describe("final JSON tool-call boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["contentBlockStop", "messageStop", "eof"])("refuses truncated Bedrock input at %s", async finalizer => {
		const frames = [
			bedrockEvent("messageStart", JSON.stringify({ role: "assistant" })),
			bedrockEvent(
				"contentBlockStart",
				JSON.stringify({ contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "write" } } }),
			),
			bedrockEvent(
				"contentBlockDelta",
				JSON.stringify({ contentBlockIndex: 0, delta: { toolUse: { input: raw } } }),
			),
			...(finalizer === "contentBlockStop"
				? [bedrockEvent("contentBlockStop", JSON.stringify({ contentBlockIndex: 0 }))]
				: []),
			...(finalizer !== "eof" ? [bedrockEvent("messageStop", JSON.stringify({ stopReason: "tool_use" }))] : []),
		];
		const result = await streamBedrock(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const frame of frames) controller.enqueue(frame);
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
				),
		}).result();
		if (finalizer !== "eof") expect(result.stopReason).toBe("toolUse");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
		expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
	});
});

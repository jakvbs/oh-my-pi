import { expect, test } from "bun:test";
import judgeProtocol from "./prompts/protocol.md" with { type: "text" };
import { countTextTokens } from "./token-count";

test("counts text with the native o200k tokenizer", () => {
	expect(countTextTokens("hello world")).toBe(2);
	expect(countTextTokens("Zażółć gęślą jaźń")).toBe(11);
	expect(countTextTokens(["hello world", "Zażółć gęślą jaźń"])).toBe(13);
});

test("keeps the shared judge protocol within its context budget", () => {
	expect(countTextTokens(judgeProtocol)).toBeLessThanOrEqual(1_500);
});

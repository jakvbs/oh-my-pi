import { expect, test } from "bun:test";
import { countTextTokens } from "./token-count";

test("counts text with the native o200k tokenizer", () => {
	expect(countTextTokens("hello world")).toBe(2);
	expect(countTextTokens("Zażółć gęślą jaźń")).toBe(11);
	expect(countTextTokens(["hello world", "Zażółć gęślą jaźń"])).toBe(13);
});

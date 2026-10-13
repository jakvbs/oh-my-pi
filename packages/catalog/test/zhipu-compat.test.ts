import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Resolver-branch coverage for the URL-detected `isZhipu` path (BigModel
 * endpoints configured as custom providers). GLM-5.2+ additionally accepts
 * `reasoning_effort`; older BigModel thinking SKUs keep the binary Z.AI-shaped
 * toggle only.
 */

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "glm-4.7",
	name: "GLM-4.7",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function zhipuByBaseUrl(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		provider: "custom",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
	};
}

function zhipuGlm52ByOfficialBaseUrl(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		id: "glm-5.2",
		name: "GLM-5.2",
		provider: "custom",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	};
}

describe("openai-completions compat — BigModel host branch", () => {
	it("detects zhipu by baseUrl when provider id is custom", () => {
		const compat = resolveModelPolicy(zhipuByBaseUrl()).compat;

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("enables reasoning_effort for GLM-5.2 on the official BigModel endpoint", () => {
		const officialCompat = resolveModelPolicy(zhipuGlm52ByOfficialBaseUrl()).compat;

		expect(officialCompat.thinkingFormat).toBe("zai");
		expect(officialCompat.supportsReasoningEffort).toBe(true);
		expect(officialCompat.reasoningContentField).toBe("reasoning_content");
		expect(officialCompat.maxTokensField).toBe("max_tokens");
	});

	it("lets explicit model.compat overrides win at the resolver layer", () => {
		const model: ModelSpec<"openai-completions"> = {
			...zhipuByBaseUrl(),
			compat: {
				supportsDeveloperRole: true,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		};
		const resolved = resolveModelPolicy(model).compat;

		expect(resolved.supportsDeveloperRole).toBe(true);
		expect(resolved.supportsReasoningEffort).toBe(true);
		expect(resolved.thinkingFormat).toBe("openai");
		// Untouched fields still come from the zhipu branch.
		expect(resolved.reasoningContentField).toBe("reasoning_content");
	});
});

describe("openai-completions compat — GLM coding-plan stream idle timeout", () => {
	function glm52(provider: string, baseUrl: string): ModelSpec<"openai-completions"> {
		return { ...baseModel, id: "glm-5.2", name: "GLM-5.2", provider, baseUrl };
	}

	// GLM coding-plan SKUs idle for minutes mid-reasoning; the 600s watchdog
	// floor must apply on every gateway that fronts them, not just the native
	// Z.AI host (issue #4758: GLM-5.2 via opencode-go stalled with
	// "OpenAI completions stream stalled while waiting for the next event").
	it("widens the idle timeout to 600s for GLM-5.x on Z.AI and OpenCode gateways", () => {
		expect(resolveModelPolicy(glm52("zai", "https://api.z.ai/api/coding/paas/v4")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
		expect(resolveModelPolicy(glm52("opencode-go", "https://opencode.ai/zen/go/v1")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
		expect(resolveModelPolicy(glm52("opencode-zen", "https://opencode.ai/zen/v1")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
	});

	it("does not widen non-GLM models on the OpenCode gateway via the GLM floor", () => {
		const kimi = resolveModelPolicy({
			...baseModel,
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		}).compat;
		expect(kimi.streamIdleTimeoutMs).toBeUndefined();
	});
});

import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import {
	AvailableModelsResponse_ModelDetailsSchema,
	AvailableModelsResponseSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("provider default selection", () => {
	/**
	 * `pickDefaultAvailableModel` prefers the first model whose id equals its
	 * provider's declared default and falls through to `availableModels[0]`
	 * when nothing matches. Synthetic's default pointed at `hf:zai-org/GLM-5.1`
	 * after the provider moved to GLM-5.2, so an account with only
	 * `SYNTHETIC_API_KEY` opened on whichever model sorted first instead of the
	 * declared default.
	 *
	 * The default is moved to the back of the availability list rather than
	 * relying on catalog order, so the assertion keeps proving that the picker
	 * overrides position — not that `gen:models` happens to sort some other
	 * model first.
	 */
	test("picks Synthetic's declared default over availability order", () => {
		const bundled = getBundledModels("synthetic") as Model<Api>[];
		const declaredDefault = bundled.find(model => model.id === DEFAULT_MODEL_PER_PROVIDER.synthetic);
		expect(declaredDefault).toBeDefined();
		if (!declaredDefault) return;

		const available = [...bundled.filter(model => model !== declaredDefault), declaredDefault];
		expect(available.length).toBeGreaterThan(1);

		const picked = pickDefaultAvailableModel(available);

		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.synthetic);
	});

	test("keeps Cursor on its bundled default when the account default is the Auto router", async () => {
		const ids = ["default", DEFAULT_MODEL_PER_PROVIDER.cursor];
		const responses: Record<string, Uint8Array> = {
			"/agent.v1.AgentService/GetUsableModels": toBinary(
				GetUsableModelsResponseSchema,
				create(GetUsableModelsResponseSchema, {
					models: ids.map(modelId => create(ModelDetailsSchema, { modelId })),
				}),
			),
			"/aiserver.v1.AiService/AvailableModels": toBinary(
				AvailableModelsResponseSchema,
				create(AvailableModelsResponseSchema, {
					models: ids.map(name =>
						create(AvailableModelsResponse_ModelDetailsSchema, { name, supportsAgent: true }),
					),
				}),
			),
			"/agent.v1.AgentService/GetDefaultModelForCli": toBinary(
				GetDefaultModelForCliResponseSchema,
				create(GetDefaultModelForCliResponseSchema, { model: create(ModelDetailsSchema, { modelId: "default" }) }),
			),
		};
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				const body = responses[new URL(request.url).pathname];
				return body ? new Response(body) : new Response(null, { status: 404 });
			},
		});
		try {
			const specs = await fetchCursorUsableModels({
				apiKey: "account-token",
				baseUrl: server.url.toString(),
				timeoutMs: 1_000,
			});
			const cursor = (specs ?? []).map(spec => buildModel(spec));
			expect(cursor.map(model => model.id).sort()).toEqual([...ids].sort());

			const picked = pickDefaultAvailableModel(cursor);

			expect(picked).toMatchObject({ provider: "cursor", id: DEFAULT_MODEL_PER_PROVIDER.cursor });
		} finally {
			server.stop(true);
		}
	});
});

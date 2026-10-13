import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { metaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog/types";

const MUSE_SPARK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};
// Meta documents the `max` tier for Muse Spark 1.3 standard and contributor tiers.
const MUSE_SPARK_MAX_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
}

describe("Meta Model API provider", () => {
	test("live discovery keeps seeded capabilities for ids Meta lists without metadata", async () => {
		// api.meta.ai/v1/models returns bare `{id}` rows: no name, limits,
		// reasoning, or pricing. Without the seed as reference, a newly shipped
		// revision surfaced as a text-only model with an unknown context window
		// and "Current model does not support thinking".
		const options = metaModelManagerOptions({
			apiKey: "meta-key",
			fetch: async () => modelListResponse(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-image-1.0"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get("muse-spark-1.3")).toMatchObject({
			name: "Muse Spark 1.3",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: MUSE_SPARK_MAX_THINKING,
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			thinking: MUSE_SPARK_MAX_THINKING,
		});
		// Image/voice SKUs on the same roster are not chat models.
		expect(byId.has("muse-image-1.0")).toBe(false);
	});

	test("unseeded Muse Spark revisions inherit lineage capabilities and tier naming", async () => {
		// Meta ships revisions gateway-first; until the seed lists one it must
		// still resolve with the lineage's window, thinking ladder, and pricing
		// rather than the bare discovery defaults. The ladder is rule-derived
		// (only reviewed seed rows advertise `max`), so assert the built model
		// the manager hands out.
		const options = metaModelManagerOptions({
			apiKey: "meta-key",
			fetch: async () => modelListResponse(["muse-spark-1.4", "muse-spark-1.4-contributor", "muse-spark-2.0.1"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, buildModel(model)]));
		expect(byId.get("muse-spark-1.4")).toMatchObject({
			name: "Muse Spark 1.4",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			thinking: MUSE_SPARK_THINKING,
		});
		expect(byId.get("muse-spark-1.4-contributor")).toMatchObject({
			name: "Muse Spark 1.4 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			thinking: MUSE_SPARK_THINKING,
		});
		expect(byId.get("muse-spark-2.0.1")).toMatchObject({ name: "Muse Spark 2.0.1", reasoning: true });
	});

	test("exposes the max tier on bundled 1.3 standard and contributor rows only", () => {
		for (const id of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
			expect(getBundledModel("meta", id)?.thinking?.efforts).toEqual([
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			]);
		}
		for (const id of ["muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(getBundledModel("meta", id)?.thinking?.efforts).toEqual([
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
			]);
		}
	});
});

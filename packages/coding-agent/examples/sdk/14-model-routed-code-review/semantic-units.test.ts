import { expect, test } from "bun:test";
import type { SemanticSourceCatalog } from "./semantic-chunks";
import { buildDeterministicSourceIndex, type LspSymbolSnapshot, validateSemanticUnitPlan } from "./semantic-units";

const sources = [
	{
		id: "source-1:handler.ts",
		path: "/repo/src/handler.ts",
		content: "export function handle() {\n\treturn service();\n}",
	},
	{
		id: "source-2:service.ts",
		path: "/repo/src/service.ts",
		content: "export function service() {\n\treturn 1;\n}",
	},
];

const catalog: SemanticSourceCatalog = {
	sources: [
		{
			id: sources[0]!.id,
			estimatedTokens: 12,
			outline: sources[0]!.content,
			chunked: false,
			chunks: [],
		},
		{
			id: sources[1]!.id,
			estimatedTokens: 10,
			outline: sources[1]!.content,
			chunked: false,
			chunks: [],
		},
	],
	chunksById: new Map(),
};

const lspSnapshot: LspSymbolSnapshot = {
	status: "available",
	symbols: "ƒ handle @ line 1",
};

const loadLspSymbols = async () => lspSnapshot;

test("builds a stable AST/LSP source index with addressable fragments", async () => {
	const first = await buildDeterministicSourceIndex(sources, catalog, loadLspSymbols);
	const second = await buildDeterministicSourceIndex(sources, catalog, loadLspSymbols);

	expect(first.hash).toBe(second.hash);
	expect(first.sources).toHaveLength(2);
	expect(first.sources[0]).toMatchObject({
		id: "source-1:handler.ts",
		lsp: lspSnapshot,
		fragments: [
			{
				sourceId: "source-1:handler.ts",
				startLine: 1,
				endLine: 3,
			},
		],
	});
	expect(first.fragmentsById.size).toBe(2);
});

test("validates exact primary ownership and computes unit budgets", async () => {
	const index = await buildDeterministicSourceIndex(sources, catalog, loadLspSymbols);
	const [handlerFragment, serviceFragment] = [...index.fragmentsById.keys()];
	if (!handlerFragment || !serviceFragment) throw new Error("Expected source fragments");

	const plan = validateSemanticUnitPlan(
		{
			units: [
				{
					id: "request-workflow",
					behavior: "Handle one request through the service policy",
					owner_source_id: "source-1",
					primary_fragment_ids: [handlerFragment, serviceFragment],
					supporting_fragment_ids: [],
					rationale: "The handler and service jointly implement one observable workflow.",
					supporting_context_reason: null,
					oversize_reason: null,
				},
			],
		},
		index,
	);

	expect(plan.units[0]).toMatchObject({
		id: "request-workflow",
		owner_source_id: sources[0]!.id,
		primaryTokens: 22,
		supportingTokens: 0,
		estimatedTokens: 22,
	});
	expect(() =>
		validateSemanticUnitPlan(
			{
				units: [
					{
						...plan.units[0]!,
						primary_fragment_ids: [handlerFragment],
					},
				],
			},
			index,
		),
	).toThrow("has no primary owner");
});

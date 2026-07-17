import { expect, test } from "bun:test";
import type { SemanticSourceCatalog } from "./semantic-chunks";
import {
	assertPlanMatchesSourceIndex,
	buildDeterministicSourceIndex,
	createSemanticPlanArtifact,
	type LspSymbolSnapshot,
	normalizeSemanticUnitPlan,
	packSemanticUnitPlan,
	parseSemanticPlanArtifact,
} from "./semantic-units";

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
			imports: [],
			chunked: false,
			chunks: [],
		},
		{
			id: sources[1]!.id,
			estimatedTokens: 10,
			outline: sources[1]!.content,
			chunked: false,
			imports: [],
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

test("relates adjacent fragments and test files to their implementation", async () => {
	const relatedSources = [
		{ id: "source-1:workflow.ts", path: "/repo/workflow.ts", content: "export function run() { return 1; }" },
		{
			id: "source-2:workflow.test.ts",
			path: "/repo/workflow.test.ts",
			content: 'import { run } from "./workflow";\ntest("run", () => { expect(run()).toBe(1); });',
		},
	];
	const relatedCatalog: SemanticSourceCatalog = {
		sources: relatedSources.map(source => ({
			id: source.id,
			estimatedTokens: 10,
			outline: source.content,
			chunked: false,
			imports: source.path.endsWith(".test.ts") ? ["./workflow"] : [],
			chunks: [],
		})),
		chunksById: new Map(),
	};

	const index = await buildDeterministicSourceIndex(relatedSources, relatedCatalog, loadLspSymbols);

	const implementationFragment = index.sources[0]?.fragments[0];
	const testFragment = index.sources[1]?.fragments[0];
	if (!implementationFragment || !testFragment) throw new Error("Expected related fragments");
	expect(index.relations).toEqual([
		{
			kind: "source-import",
			strength: "medium",
			fromFragmentId: testFragment.id,
			toFragmentId: implementationFragment.id,
		},
		{
			kind: "test-subject",
			strength: "strong",
			fromFragmentId: testFragment.id,
			toFragmentId: implementationFragment.id,
		},
	]);
	const normalized = normalizeSemanticUnitPlan(
		{
			units: [
				{
					id: "workflow",
					behavior: "Run and verify the workflow",
					owner_source_id: relatedSources[0]!.id,
					primary_fragment_ids: [implementationFragment.id],
					supporting_fragment_ids: ["invented-fragment"],
					rationale: "Implementation and test form one contract.",
					supporting_context_reason: null,
					oversize_reason: null,
				},
			],
		},
		index,
	);
	expect(normalized.units[0]).toMatchObject({
		primary_fragment_ids: [implementationFragment.id, testFragment.id],
		supporting_fragment_ids: [],
	});
	expect(packSemanticUnitPlan(normalized, index).units).toHaveLength(1);
	expect(() =>
		packSemanticUnitPlan(
			{
				units: [
					{
						id: "implementation",
						behavior: "Run the workflow",
						owner_source_id: relatedSources[0]!.id,
						primary_fragment_ids: [implementationFragment.id],
						supporting_fragment_ids: [],
						rationale: "Implementation behavior.",
						supporting_context_reason: null,
						oversize_reason: null,
					},
					{
						id: "tests",
						behavior: "Test the workflow separately",
						owner_source_id: relatedSources[1]!.id,
						primary_fragment_ids: [testFragment.id],
						supporting_fragment_ids: [],
						rationale: "Test behavior.",
						supporting_context_reason: null,
						oversize_reason: null,
					},
				],
			},
			index,
		),
	).toThrow("Strong test-subject relation is split across semantic units");
});

test("validates exact primary ownership and computes unit budgets", async () => {
	const index = await buildDeterministicSourceIndex(sources, catalog, loadLspSymbols);
	const [handlerFragment, serviceFragment] = [...index.fragmentsById.keys()];
	if (!handlerFragment || !serviceFragment) throw new Error("Expected source fragments");

	const plan = packSemanticUnitPlan(
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
		packSemanticUnitPlan(
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

test("persists a hash-verified plan without source contents and rejects stale indexes", async () => {
	const index = await buildDeterministicSourceIndex(sources, catalog, loadLspSymbols);
	const fragmentIds = [...index.fragmentsById.keys()];
	const plan = packSemanticUnitPlan(
		{
			units: [
				{
					id: "request-workflow",
					behavior: "Handle one request through the service policy",
					owner_source_id: sources[0]!.id,
					primary_fragment_ids: fragmentIds,
					supporting_fragment_ids: [],
					rationale: "The handler and service jointly implement one observable workflow.",
					supporting_context_reason: null,
					oversize_reason: null,
				},
			],
		},
		index,
	);
	const artifact = createSemanticPlanArtifact({
		createdAt: "2026-07-17T12:00:00.000Z",
		index,
		plan,
		reviewGoal: "Review request handling",
		riskLevel: "medium",
	});
	const serialized = JSON.stringify(artifact);

	expect(serialized).not.toContain(sources[0]!.content);
	expect(artifact.planHash).toMatch(/^[a-f0-9]{64}$/);
	expect(artifact.sources[0]?.fragments[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
	expect(parseSemanticPlanArtifact(JSON.parse(serialized))).toEqual(artifact);
	expect(() => parseSemanticPlanArtifact({ ...artifact, reviewGoal: "tampered" })).toThrow("plan hash");
	expect(() => assertPlanMatchesSourceIndex(artifact, { ...index, hash: "stale" })).toThrow("sources changed");
});

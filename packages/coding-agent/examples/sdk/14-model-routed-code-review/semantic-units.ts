import { createHash } from "node:crypto";
import { LspTool, Settings, type ToolSession } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import type { ChunkableSource, SemanticChunk, SemanticSourceCatalog } from "./semantic-chunks";

export const TARGET_UNIT_TOKENS = 30_000;
export const PREFERRED_MAX_UNIT_TOKENS = 50_000;
export const HARD_MAX_UNIT_TOKENS = 80_000;

export type LspSymbolSnapshot = {
	status: "available" | "unavailable" | "error";
	symbols: string;
};

export type SourceFragment = {
	id: string;
	sourceId: string;
	label: string;
	startLine: number;
	endLine: number;
	estimatedTokens: number;
	contextRange?: { startLine: number; endLine: number };
};

export type IndexedSource = {
	id: string;
	path: string;
	estimatedTokens: number;
	outline: string;
	preambleEndLine?: number;
	lsp: LspSymbolSnapshot;
	fragments: SourceFragment[];
};

export type DeterministicSourceIndex = {
	version: "semantic-source-index/1.0.0";
	hash: string;
	totalEstimatedTokens: number;
	sources: IndexedSource[];
	fragmentsById: Map<string, SourceFragment>;
};

export const semanticUnitSchema = z
	.object({
		id: z.string().min(1),
		behavior: z.string().min(1),
		owner_source_id: z.string().min(1),
		primary_fragment_ids: z.array(z.string().min(1)).min(1),
		supporting_fragment_ids: z.array(z.string().min(1)),
		rationale: z.string().min(1),
		supporting_context_reason: z.string().min(1).nullable(),
		oversize_reason: z.string().min(1).nullable(),
	})
	.strict();

export const semanticUnitPlanSchema = z
	.object({
		units: z.array(semanticUnitSchema).min(1),
	})
	.strict();

export type SemanticUnitProposal = z.infer<typeof semanticUnitSchema>;
export type SemanticUnitPlanProposal = z.infer<typeof semanticUnitPlanSchema>;

export type SemanticUnit = SemanticUnitProposal & {
	primaryTokens: number;
	supportingTokens: number;
	estimatedTokens: number;
};

export type SemanticUnitPlan = {
	units: SemanticUnit[];
	uniqueEvidenceTokens: number;
	plannedEvidenceTokens: number;
};

export type LoadLspSymbols = (path: string) => Promise<LspSymbolSnapshot>;

export async function queryLspSymbols(path: string): Promise<LspSymbolSnapshot> {
	const toolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({}),
	} satisfies ToolSession;
	const tool = new LspTool(toolSession);
	try {
		const result = await tool.execute(`semantic-index:${path}`, {
			action: "symbols",
			file: path,
			timeout: 15,
		});
		const symbols = result.content
			.flatMap(block => (block.type === "text" && block.text ? [block.text] : []))
			.join("\n");
		if (result.details?.success === false || symbols.startsWith("No language server")) {
			return { status: "unavailable", symbols };
		}
		return { status: "available", symbols };
	} catch (error) {
		return { status: "error", symbols: error instanceof Error ? error.message : String(error) };
	}
}

export async function buildDeterministicSourceIndex(
	sources: ChunkableSource[],
	catalog: SemanticSourceCatalog,
	loadLspSymbols: LoadLspSymbols = queryLspSymbols,
): Promise<DeterministicSourceIndex> {
	const sourcesById = new Map(sources.map(source => [source.id, source]));
	const indexedSources = await Promise.all(
		catalog.sources.map(async entry => {
			const source = sourcesById.get(entry.id);
			if (!source) throw new Error(`Source catalog entry has no source: ${entry.id}`);
			const fragments = entry.chunked
				? entry.chunks.map(chunk => sourceFragment(chunk))
				: [wholeSourceFragment(source, entry.estimatedTokens)];
			return {
				id: source.id,
				path: source.path,
				estimatedTokens: entry.estimatedTokens,
				outline: entry.outline,
				preambleEndLine: entry.preambleEndLine,
				lsp: await loadLspSymbols(source.path),
				fragments,
			} satisfies IndexedSource;
		}),
	);
	const fragments = indexedSources.flatMap(source => source.fragments);
	const serialized = {
		version: "semantic-source-index/1.0.0",
		sources: indexedSources,
	};
	return {
		version: "semantic-source-index/1.0.0",
		hash: createHash("sha256").update(JSON.stringify(serialized)).digest("hex"),
		totalEstimatedTokens: indexedSources.reduce((total, source) => total + source.estimatedTokens, 0),
		sources: indexedSources,
		fragmentsById: new Map(fragments.map(fragment => [fragment.id, fragment])),
	};
}

export function validateSemanticUnitPlan(
	proposal: SemanticUnitPlanProposal,
	index: DeterministicSourceIndex,
): SemanticUnitPlan {
	const sourceIds = new Set(index.sources.map(source => source.id));
	const unitIds = new Set<string>();
	const primaryOwners = new Map<string, string>();
	const units = proposal.units.map(unit => {
		if (unitIds.has(unit.id)) throw new Error(`Duplicate semantic unit id: ${unit.id}`);
		const ownerSourceId = resolveSourceId(unit.owner_source_id, sourceIds);
		if (!ownerSourceId) throw new Error(`Unknown owner source: ${unit.owner_source_id}`);

		const primaryIds = uniqueIds(unit.primary_fragment_ids, `${unit.id} primary fragments`);
		const supportingIds = uniqueIds(unit.supporting_fragment_ids, `${unit.id} supporting fragments`);
		const overlap = primaryIds.find(id => supportingIds.includes(id));
		if (overlap) throw new Error(`Semantic unit ${unit.id} uses ${overlap} as primary and supporting evidence`);

		const primary = primaryIds.map(id => requireFragment(index, id));
		const supporting = supportingIds.map(id => requireFragment(index, id));
		if (!primary.some(fragment => fragment.sourceId === ownerSourceId)) {
			throw new Error(`Semantic unit ${unit.id} owner has no primary fragment`);
		}
		for (const fragment of primary) {
			const previousOwner = primaryOwners.get(fragment.id);
			if (previousOwner) {
				throw new Error(`Fragment ${fragment.id} has multiple primary owners: ${previousOwner}, ${unit.id}`);
			}
			primaryOwners.set(fragment.id, unit.id);
		}

		const primaryTokens = sumFragmentTokens(primary);
		const supportingTokens = sumFragmentTokens(supporting);
		const estimatedTokens = primaryTokens + supportingTokens;
		if (supportingTokens > primaryTokens * 0.3 && !unit.supporting_context_reason) {
			throw new Error(`Semantic unit ${unit.id} exceeds the 30% supporting-context budget without a reason`);
		}
		if (estimatedTokens > HARD_MAX_UNIT_TOKENS) {
			throw new Error(`Semantic unit ${unit.id} exceeds the ${HARD_MAX_UNIT_TOKENS}-token hard limit`);
		}
		if (estimatedTokens > PREFERRED_MAX_UNIT_TOKENS && !unit.oversize_reason) {
			throw new Error(`Semantic unit ${unit.id} exceeds the preferred token limit without a reason`);
		}
		return {
			...unit,
			owner_source_id: ownerSourceId,
			primary_fragment_ids: primaryIds,
			supporting_fragment_ids: supportingIds,
			primaryTokens,
			supportingTokens,
			estimatedTokens,
		};
	});

	for (const fragmentId of index.fragmentsById.keys()) {
		if (!primaryOwners.has(fragmentId)) throw new Error(`Fragment ${fragmentId} has no primary owner`);
	}
	return {
		units,
		uniqueEvidenceTokens: sumFragmentTokens([...index.fragmentsById.values()]),
		plannedEvidenceTokens: units.reduce((total, unit) => total + unit.estimatedTokens, 0),
	};
}

function resolveSourceId(candidate: string, sourceIds: Set<string>) {
	if (sourceIds.has(candidate)) return candidate;
	const matches = [...sourceIds].filter(sourceId => sourceId.startsWith(`${candidate}:`));
	return matches.length === 1 ? matches[0] : undefined;
}

function sourceFragment(chunk: SemanticChunk): SourceFragment {
	return { ...chunk };
}

function wholeSourceFragment(source: ChunkableSource, estimatedTokens: number): SourceFragment {
	const endLine = source.content.split("\n").length;
	const id = `fragment:${createHash("sha256")
		.update(`${source.id}:1:${endLine}:${source.content}`)
		.digest("hex")
		.slice(0, 12)}`;
	return {
		id,
		sourceId: source.id,
		label: "whole source",
		startLine: 1,
		endLine,
		estimatedTokens,
	};
}

function uniqueIds(ids: string[], label: string) {
	const unique = [...new Set(ids)];
	if (unique.length !== ids.length) throw new Error(`Duplicate ${label}`);
	return unique;
}

function requireFragment(index: DeterministicSourceIndex, id: string) {
	const fragment = index.fragmentsById.get(id);
	if (!fragment) throw new Error(`Unknown source fragment: ${id}`);
	return fragment;
}

function sumFragmentTokens(fragments: SourceFragment[]) {
	return fragments.reduce((total, fragment) => total + fragment.estimatedTokens, 0);
}

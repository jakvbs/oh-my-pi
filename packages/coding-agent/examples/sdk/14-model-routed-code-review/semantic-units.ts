import { createHash } from "node:crypto";
import * as path from "node:path";
import { LspTool, Settings, type ToolSession } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import type { ChunkableSource, SemanticChunk, SemanticSourceCatalog } from "./semantic-chunks";

export const TARGET_UNIT_TOKENS = 30_000;
export const PREFERRED_MAX_UNIT_TOKENS = 50_000;
export const HARD_MAX_UNIT_TOKENS = 80_000;
export const SEMANTIC_PLAN_SCHEMA_VERSION = "semantic-unit-plan/1.0.0" as const;

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
	hash: string;
	contextRange?: { startLine: number; endLine: number };
};
export type FragmentRelation = {
	fromFragmentId: string;
	toFragmentId: string;
	kind: "same-source-adjacent" | "source-import" | "test-subject";
	strength: "medium" | "strong";
};

export type IndexedSource = {
	id: string;
	path: string;
	estimatedTokens: number;
	outline: string;
	imports: string[];
	preambleEndLine?: number;
	lsp: LspSymbolSnapshot;
	fragments: SourceFragment[];
};

export type DeterministicSourceIndex = {
	version: "semantic-source-index/2.0.0";
	hash: string;
	totalEstimatedTokens: number;
	sources: IndexedSource[];
	fragmentsById: Map<string, SourceFragment>;
	relations: FragmentRelation[];
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

const persistedFragmentSchema = z
	.object({
		id: z.string().min(1),
		sourceId: z.string().min(1),
		label: z.string().min(1),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		estimatedTokens: z.number().int().nonnegative(),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		contextRange: z
			.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
			.strict()
			.optional(),
	})
	.strict();

const persistedUnitSchema = semanticUnitSchema.extend({
	primaryTokens: z.number().int().nonnegative(),
	supportingTokens: z.number().int().nonnegative(),
	estimatedTokens: z.number().int().nonnegative(),
});

const semanticPlanArtifactPayloadSchema = z
	.object({
		schemaVersion: z.literal(SEMANTIC_PLAN_SCHEMA_VERSION),
		createdAt: z.iso.datetime(),
		reviewGoal: z.string().min(1),
		riskLevel: z.enum(["low", "medium", "high"]),
		sourceIndexHash: z.string().regex(/^[a-f0-9]{64}$/),
		sources: z.array(
			z
				.object({
					id: z.string().min(1),
					path: z.string().min(1),
					estimatedTokens: z.number().int().nonnegative(),
					fragments: z.array(persistedFragmentSchema).min(1),
				})
				.strict(),
		),
		units: z.array(persistedUnitSchema).min(1),
		uniqueEvidenceTokens: z.number().int().nonnegative(),
		plannedEvidenceTokens: z.number().int().nonnegative(),
	})
	.strict();

export const semanticPlanArtifactSchema = semanticPlanArtifactPayloadSchema
	.extend({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();

export type SemanticPlanArtifact = z.infer<typeof semanticPlanArtifactSchema>;

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

export function createSemanticPlanArtifact({
	createdAt = new Date().toISOString(),
	index,
	plan,
	reviewGoal,
	riskLevel,
}: {
	createdAt?: string;
	index: DeterministicSourceIndex;
	plan: SemanticUnitPlan;
	reviewGoal: string;
	riskLevel: "low" | "medium" | "high";
}): SemanticPlanArtifact {
	const payload = semanticPlanArtifactPayloadSchema.parse({
		schemaVersion: SEMANTIC_PLAN_SCHEMA_VERSION,
		createdAt,
		reviewGoal,
		riskLevel,
		sourceIndexHash: index.hash,
		sources: index.sources.map(source => ({
			id: source.id,
			path: source.path,
			estimatedTokens: source.estimatedTokens,
			fragments: source.fragments,
		})),
		units: plan.units,
		uniqueEvidenceTokens: plan.uniqueEvidenceTokens,
		plannedEvidenceTokens: plan.plannedEvidenceTokens,
	});
	return { ...payload, planHash: hashJson(payload) };
}

export function parseSemanticPlanArtifact(value: unknown): SemanticPlanArtifact {
	const artifact = semanticPlanArtifactSchema.parse(value);
	const { planHash, ...payload } = artifact;
	if (hashJson(payload) !== planHash) throw new Error("Semantic plan hash does not match its contents");
	return artifact;
}

export function assertPlanMatchesSourceIndex(artifact: SemanticPlanArtifact, index: DeterministicSourceIndex) {
	if (artifact.sourceIndexHash !== index.hash) {
		throw new Error("Semantic plan is stale because its sources changed");
	}
	const validated = packSemanticUnitPlan({ units: artifact.units }, index);
	if (
		validated.uniqueEvidenceTokens !== artifact.uniqueEvidenceTokens ||
		validated.plannedEvidenceTokens !== artifact.plannedEvidenceTokens
	) {
		throw new Error("Semantic plan metrics do not match the current source index");
	}
	return validated;
}

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
				? entry.chunks.map(chunk => sourceFragment(chunk, source.content))
				: [wholeSourceFragment(source, entry.estimatedTokens)];
			return {
				id: source.id,
				path: source.path,
				estimatedTokens: entry.estimatedTokens,
				outline: entry.outline,
				preambleEndLine: entry.preambleEndLine,
				imports: entry.imports,
				lsp: await loadLspSymbols(source.path),
				fragments,
			} satisfies IndexedSource;
		}),
	);
	const fragments = indexedSources.flatMap(source => source.fragments);
	const relations = buildFragmentRelations(indexedSources);
	const serialized = {
		version: "semantic-source-index/2.0.0",
		sources: indexedSources.map(({ lsp: _lsp, ...source }) => source),
		relations,
	};
	return {
		version: "semantic-source-index/2.0.0",
		hash: createHash("sha256").update(JSON.stringify(serialized)).digest("hex"),
		totalEstimatedTokens: indexedSources.reduce((total, source) => total + source.estimatedTokens, 0),
		sources: indexedSources,
		fragmentsById: new Map(fragments.map(fragment => [fragment.id, fragment])),
		relations,
	};
}

export function normalizeSemanticUnitPlan(
	proposal: SemanticUnitPlanProposal,
	index: DeterministicSourceIndex,
): SemanticUnitPlanProposal {
	let units = proposal.units.map(unit => ({
		...unit,
		primary_fragment_ids: unit.primary_fragment_ids.filter(id => index.fragmentsById.has(id)),
		supporting_fragment_ids: unit.supporting_fragment_ids.filter(id => index.fragmentsById.has(id)),
	}));
	if (units.length === 0) return proposal;

	const claimed = new Set<string>();
	for (const unit of units) {
		unit.primary_fragment_ids = unit.primary_fragment_ids.filter(id => {
			if (claimed.has(id)) return false;
			claimed.add(id);
			return true;
		});
	}
	for (const fragment of index.fragmentsById.values()) {
		if (claimed.has(fragment.id)) continue;
		const target = selectUnitForFragment(units, fragment, index);
		target.primary_fragment_ids.push(fragment.id);
		claimed.add(fragment.id);
	}

	for (;;) {
		const owners = new Map(
			units.flatMap((unit, unitIndex) => unit.primary_fragment_ids.map(id => [id, unitIndex] as const)),
		);
		const splitRelation = index.relations.find(
			relation =>
				relation.strength === "strong" && owners.get(relation.fromFragmentId) !== owners.get(relation.toFragmentId),
		);
		if (!splitRelation) break;
		const fromIndex = owners.get(splitRelation.fromFragmentId);
		const toIndex = owners.get(splitRelation.toFragmentId);
		if (fromIndex === undefined || toIndex === undefined) break;
		const targetIndex = Math.min(fromIndex, toIndex);
		const sourceIndex = Math.max(fromIndex, toIndex);
		const target = units[targetIndex];
		const source = units[sourceIndex];
		if (!target || !source) break;
		target.primary_fragment_ids.push(...source.primary_fragment_ids);
		target.supporting_fragment_ids.push(...source.supporting_fragment_ids);
		target.behavior = `${target.behavior}; ${source.behavior}`;
		target.rationale = `${target.rationale} ${source.rationale}`;
		target.supporting_context_reason ??= source.supporting_context_reason;
		target.oversize_reason ??= source.oversize_reason;
		units.splice(sourceIndex, 1);
	}

	const sourceIds = new Set(index.sources.map(source => source.id));
	units = units.filter(unit => unit.primary_fragment_ids.length > 0);
	for (const unit of units) {
		unit.primary_fragment_ids = [...new Set(unit.primary_fragment_ids)];
		const primary = new Set(unit.primary_fragment_ids);
		unit.supporting_fragment_ids = [
			...new Set(unit.supporting_fragment_ids.filter(id => index.fragmentsById.has(id) && !primary.has(id))),
		];
		const ownerSourceId = resolveSourceId(unit.owner_source_id, sourceIds);
		if (!unit.primary_fragment_ids.some(id => index.fragmentsById.get(id)?.sourceId === ownerSourceId)) {
			const owner = unit.primary_fragment_ids
				.map(id => requireFragment(index, id))
				.sort((left, right) => right.estimatedTokens - left.estimatedTokens || left.id.localeCompare(right.id))[0];
			if (owner) unit.owner_source_id = owner.sourceId;
		}
	}
	return { units };
}

export function packSemanticUnitPlan(
	proposal: SemanticUnitPlanProposal,
	index: DeterministicSourceIndex,
): SemanticUnitPlan {
	const sourceIds = new Set(index.sources.map(source => source.id));
	const unitIds = new Set<string>();
	const primaryOwners = new Map<string, string>();
	const units = proposal.units.map(unit => {
		if (unitIds.has(unit.id)) throw new Error(`Duplicate semantic unit id: ${unit.id}`);
		unitIds.add(unit.id);
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
	for (const relation of index.relations) {
		if (relation.strength !== "strong") continue;
		const fromOwner = primaryOwners.get(relation.fromFragmentId);
		const toOwner = primaryOwners.get(relation.toFragmentId);
		if (fromOwner !== toOwner) {
			throw new Error(`Strong ${relation.kind} relation is split across semantic units: ${fromOwner}, ${toOwner}`);
		}
	}
	return {
		units,
		uniqueEvidenceTokens: sumFragmentTokens([...index.fragmentsById.values()]),
		plannedEvidenceTokens: units.reduce((total, unit) => total + unit.estimatedTokens, 0),
	};
}

function selectUnitForFragment(
	units: SemanticUnitProposal[],
	fragment: SourceFragment,
	index: DeterministicSourceIndex,
) {
	const sourceIds = new Set(index.sources.map(source => source.id));
	const sourcePaths = new Map(index.sources.map(source => [source.id, source.path]));
	const fragmentSource = index.sources.find(source => source.id === fragment.sourceId);
	const fragmentDescriptor = `${fragment.label} ${path.basename(fragmentSource?.path ?? "")} ${fragmentSource?.outline.slice(0, 500) ?? ""}`;
	let selected = units[0]!;
	let selectedScore = Number.NEGATIVE_INFINITY;
	let selectedTokens = Number.POSITIVE_INFINITY;
	for (const unit of units) {
		const primary = unit.primary_fragment_ids.flatMap(id => {
			const candidate = index.fragmentsById.get(id);
			return candidate ? [candidate] : [];
		});
		let score = resolveSourceId(unit.owner_source_id, sourceIds) === fragment.sourceId ? 50 : 0;
		if (labelsShareIdentifier(`${unit.behavior} ${unit.rationale}`, fragmentDescriptor)) score += 15;
		for (const candidate of primary) {
			if (candidate.sourceId === fragment.sourceId) score += 30;
			if (
				path.dirname(sourcePaths.get(candidate.sourceId) ?? "") ===
				path.dirname(sourcePaths.get(fragment.sourceId) ?? "")
			) {
				score += 3;
			}
			if (labelsShareIdentifier(candidate.label, fragment.label)) score += 2;
		}
		for (const relation of index.relations) {
			const relatedId =
				relation.fromFragmentId === fragment.id
					? relation.toFragmentId
					: relation.toFragmentId === fragment.id
						? relation.fromFragmentId
						: undefined;
			if (relatedId && unit.primary_fragment_ids.includes(relatedId)) {
				score += relation.strength === "strong" ? 100 : 10;
			}
		}
		const tokens = sumFragmentTokens(primary);
		if (score > selectedScore || (score === selectedScore && tokens < selectedTokens)) {
			selected = unit;
			selectedScore = score;
			selectedTokens = tokens;
		}
	}
	return selected;
}

function resolveSourceId(candidate: string, sourceIds: Set<string>) {
	if (sourceIds.has(candidate)) return candidate;
	const matches = [...sourceIds].filter(sourceId => sourceId.startsWith(`${candidate}:`));
	return matches.length === 1 ? matches[0] : undefined;
}

function buildFragmentRelations(sources: IndexedSource[]): FragmentRelation[] {
	const relations: FragmentRelation[] = [];
	for (const source of sources) {
		for (let index = 1; index < source.fragments.length; index++) {
			const previous = source.fragments[index - 1];
			const current = source.fragments[index];
			if (!previous || !current) continue;
			relations.push({
				fromFragmentId: previous.id,
				toFragmentId: current.id,
				kind: "same-source-adjacent",
				strength: "medium",
			});
		}
	}

	const sourcesByModulePath = new Map<string, IndexedSource>();
	for (const source of sources) {
		sourcesByModulePath.set(source.path, source);
		sourcesByModulePath.set(source.path.slice(0, -path.extname(source.path).length), source);
		if (path.basename(source.path, path.extname(source.path)) === "index") {
			sourcesByModulePath.set(path.dirname(source.path), source);
		}
	}
	for (const source of sources) {
		const fromFragment = source.fragments[0];
		if (!fromFragment) continue;
		for (const specifier of source.imports) {
			if (!specifier.startsWith(".")) continue;
			const imported = sourcesByModulePath.get(path.resolve(path.dirname(source.path), specifier));
			const toFragment = imported?.fragments[0];
			if (!toFragment || toFragment.id === fromFragment.id) continue;
			relations.push({
				fromFragmentId: fromFragment.id,
				toFragmentId: toFragment.id,
				kind: "source-import",
				strength: "medium",
			});
		}
	}

	const implementationsByStem = new Map(
		sources.filter(source => !isTestPath(source.path)).map(source => [sourceStem(source.path), source] as const),
	);
	for (const testSource of sources.filter(source => isTestPath(source.path))) {
		const implementation = implementationsByStem.get(sourceStem(testSource.path));
		if (!implementation) continue;
		for (const testFragment of testSource.fragments) {
			const implementationFragments =
				testSource.fragments.length === 1 && implementation.fragments.length === 1
					? implementation.fragments
					: implementation.fragments.filter(fragment => labelsShareIdentifier(testFragment.label, fragment.label));
			for (const implementationFragment of implementationFragments) {
				relations.push({
					fromFragmentId: testFragment.id,
					toFragmentId: implementationFragment.id,
					kind: "test-subject",
					strength: "strong",
				});
			}
		}
	}
	return relations.sort(
		(left, right) =>
			left.fromFragmentId.localeCompare(right.fromFragmentId) ||
			left.toFragmentId.localeCompare(right.toFragmentId) ||
			left.kind.localeCompare(right.kind),
	);
}

function isTestPath(filePath: string) {
	return /\.(?:test|spec)\.[^.]+$/.test(path.basename(filePath));
}

function sourceStem(filePath: string) {
	const parsed = path.parse(filePath);
	return path.join(parsed.dir, parsed.name.replace(/\.(?:test|spec)$/, ""));
}

function labelsShareIdentifier(left: string, right: string) {
	const identifiers = (value: string) =>
		new Set(
			value
				.toLowerCase()
				.match(/[a-z_$][a-z0-9_$]{2,}/g)
				?.filter(
					identifier =>
						!["async", "const", "describe", "export", "function", "return", "test"].includes(identifier),
				),
		);
	const leftIdentifiers = identifiers(left);
	return [...identifiers(right)].some(identifier => leftIdentifiers.has(identifier));
}

function sourceFragment(chunk: SemanticChunk, content: string): SourceFragment {
	return { ...chunk, hash: hashSourceRange(content, chunk.startLine, chunk.endLine) };
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
		hash: hashSourceRange(source.content, 1, endLine),
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

function hashSourceRange(content: string, startLine: number, endLine: number) {
	return createHash("sha256")
		.update(
			content
				.split("\n")
				.slice(startLine - 1, endLine)
				.join("\n"),
		)
		.digest("hex");
}

function hashJson(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sumFragmentTokens(fragments: SourceFragment[]) {
	return fragments.reduce((total, fragment) => total + fragment.estimatedTokens, 0);
}

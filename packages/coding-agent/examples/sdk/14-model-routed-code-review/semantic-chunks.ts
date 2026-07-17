import { createHash } from "node:crypto";
import { extname } from "node:path";
import { astMatch, summarizeCode } from "@oh-my-pi/pi-natives";
import { countTextTokens } from "./token-count";

const DEFAULT_CHUNK_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_CHUNK_TOKENS = 4_000;
const MAX_OUTLINE_CHARACTERS = 12_000;
const CALLABLE_PATTERNS = [
	"function $NAME($$$ARGS) { $$$BODY }",
	"async function $NAME($$$ARGS) { $$$BODY }",
	"const $NAME = ($$$ARGS) => { $$$BODY }",
	"const $NAME = async ($$$ARGS) => { $$$BODY }",
	"const $NAME = function($$$ARGS) { $$$BODY }",
	"class $NAME { $$$BODY }",
	"test($NAME, $CALLBACK)",
	"it($NAME, $CALLBACK)",
	"describe($NAME, $CALLBACK)",
];

export type ChunkableSource = {
	id: string;
	path: string;
	content: string;
};

export type SemanticChunk = {
	id: string;
	sourceId: string;
	label: string;
	startLine: number;
	endLine: number;
	estimatedTokens: number;
	contextRange?: { startLine: number; endLine: number };
};

export type SourceCatalogEntry = {
	id: string;
	estimatedTokens: number;
	outline: string;
	imports: string[];
	chunked: boolean;
	preambleEndLine?: number;
	chunks: SemanticChunk[];
};

export type SemanticSourceCatalog = {
	sources: SourceCatalogEntry[];
	chunksById: Map<string, SemanticChunk>;
};

export async function buildSemanticSourceCatalog(
	sources: ChunkableSource[],
	options: { chunkThresholdTokens?: number; maxChunkTokens?: number } = {},
): Promise<SemanticSourceCatalog> {
	const threshold = options.chunkThresholdTokens ?? DEFAULT_CHUNK_THRESHOLD_TOKENS;
	const maxChunkTokens = options.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;
	if (threshold < 1 || maxChunkTokens < 1) throw new Error("Semantic chunk token limits must be positive");

	const catalog = await Promise.all(sources.map(source => buildSourceCatalogEntry(source, threshold, maxChunkTokens)));
	return {
		sources: catalog,
		chunksById: new Map(catalog.flatMap(source => source.chunks.map(chunk => [chunk.id, chunk] as const))),
	};
}

async function buildSourceCatalogEntry(
	source: ChunkableSource,
	threshold: number,
	maxChunkTokens: number,
): Promise<SourceCatalogEntry> {
	const estimatedTokens = countTextTokens(source.content);
	const base = {
		id: source.id,
		estimatedTokens,
		outline: buildOutline(source),
		imports: scanSourceImports(source),
	};
	if (estimatedTokens <= threshold) return { ...base, chunked: false, chunks: [] };
	if (extname(source.path) === ".md") {
		return buildMarkdownCatalogEntry(source, base, maxChunkTokens);
	}
	const language = astLanguage(source.path);
	if (!language) return { ...base, chunked: false, chunks: [] };

	const result = await astMatch({
		source: source.content,
		lang: language,
		patterns: CALLABLE_PATTERNS,
		limit: 1_000,
		timeoutMs: 10_000,
	});
	if (result.limitReached || result.parseErrors?.length || result.matches.length === 0) {
		return { ...base, chunked: false, chunks: [] };
	}

	const matches = result.matches
		.sort((left, right) => left.byteStart - right.byteStart || right.byteEnd - left.byteEnd)
		.filter((match, index, all) =>
			all.slice(0, index).every(parent => match.byteStart < parent.byteStart || match.byteEnd > parent.byteEnd),
		);
	const lines = source.content.split("\n");
	const chunks: SemanticChunk[] = [];
	let nextLine = 1;
	for (const match of matches) {
		if (nextLine < match.startLine) {
			chunks.push(...splitRange(source, lines, nextLine, match.startLine - 1, maxChunkTokens, "module statements"));
		}
		const label = match.text.split("\n", 1)[0]?.trim().slice(0, 100) || "callable";
		chunks.push(
			...splitRange(source, lines, match.startLine, match.endLine, maxChunkTokens, label, {
				startLine: match.startLine,
				endLine: match.startLine,
			}),
		);
		nextLine = Math.max(nextLine, match.endLine + 1);
	}
	if (nextLine <= lines.length) {
		chunks.push(...splitRange(source, lines, nextLine, lines.length, maxChunkTokens, "module statements"));
	}
	const nonEmptyChunks = chunks.filter(chunk =>
		lines.slice(chunk.startLine - 1, chunk.endLine).some(line => line.trim().length > 0),
	);
	if (nonEmptyChunks.length < 2) return { ...base, chunked: false, chunks: [] };
	return {
		...base,
		chunked: true,
		preambleEndLine: findPreambleEndLine(lines),
		chunks: nonEmptyChunks,
	};
}

function buildMarkdownCatalogEntry(
	source: ChunkableSource,
	base: Pick<SourceCatalogEntry, "id" | "estimatedTokens" | "outline">,
	maxChunkTokens: number,
): SourceCatalogEntry {
	const lines = source.content.split("\n");
	const headingLines = lines.flatMap((line, index) => (/^#{1,3}\s+\S/.test(line) ? [index + 1] : []));
	if (headingLines.length < 2) return { ...base, chunked: false, chunks: [] };

	const chunks: SemanticChunk[] = [];
	if (headingLines[0]! > 1) {
		chunks.push(...splitRange(source, lines, 1, headingLines[0]! - 1, maxChunkTokens, "document preamble"));
	}
	for (const [index, startLine] of headingLines.entries()) {
		const endLine = (headingLines[index + 1] ?? lines.length + 1) - 1;
		chunks.push(...splitRange(source, lines, startLine, endLine, maxChunkTokens, lines[startLine - 1]!.trim()));
	}
	const nonEmptyChunks = chunks.filter(chunk =>
		lines.slice(chunk.startLine - 1, chunk.endLine).some(line => line.trim().length > 0),
	);
	return nonEmptyChunks.length < 2
		? { ...base, chunked: false, chunks: [] }
		: { ...base, chunked: true, chunks: nonEmptyChunks };
}

function splitRange(
	source: ChunkableSource,
	lines: string[],
	startLine: number,
	endLine: number,
	maxTokens: number,
	label: string,
	contextRange?: { startLine: number; endLine: number },
) {
	const chunks: SemanticChunk[] = [];
	let chunkStart = startLine;
	while (chunkStart <= endLine) {
		const remainingText = lines.slice(chunkStart - 1, endLine).join("\n");
		if (countTextTokens(remainingText) <= maxTokens) {
			chunks.push(makeChunk(source, lines, chunkStart, endLine, label, contextRange));
			break;
		}

		let low = chunkStart;
		let high = endLine;
		let bestEnd = chunkStart;
		while (low <= high) {
			const candidateEnd = Math.floor((low + high) / 2);
			const candidate = lines.slice(chunkStart - 1, candidateEnd).join("\n");
			if (candidateEnd === chunkStart || countTextTokens(candidate) <= maxTokens) {
				bestEnd = candidateEnd;
				low = candidateEnd + 1;
			} else {
				high = candidateEnd - 1;
			}
		}
		chunks.push(makeChunk(source, lines, chunkStart, bestEnd, label, contextRange));
		chunkStart = bestEnd + 1;
	}
	return chunks;
}

function makeChunk(
	source: ChunkableSource,
	lines: string[],
	startLine: number,
	endLine: number,
	label: string,
	contextRange?: { startLine: number; endLine: number },
): SemanticChunk {
	const text = lines.slice(startLine - 1, endLine).join("\n");
	const id = `chunk:${createHash("sha256")
		.update(`${source.id}:${startLine}:${endLine}:${text}`)
		.digest("hex")
		.slice(0, 12)}`;
	return {
		id,
		sourceId: source.id,
		label,
		startLine,
		endLine,
		estimatedTokens: countTextTokens(text),
		...(contextRange && (contextRange.startLine !== startLine || contextRange.endLine !== endLine)
			? { contextRange }
			: {}),
	};
}

function buildOutline(source: ChunkableSource) {
	const summary = summarizeCode({
		path: source.path,
		code: source.content,
		minBodyLines: 4,
		minCommentLines: 4,
		unfoldUntilLines: 120,
		unfoldLimitLines: 200,
	});
	const outline = summary.segments
		.map(segment =>
			segment.kind === "kept" && segment.text !== undefined
				? segment.text
				: `… lines ${segment.startLine}-${segment.endLine} elided …`,
		)
		.join("\n");
	return outline.length <= MAX_OUTLINE_CHARACTERS
		? outline
		: `${outline.slice(0, MAX_OUTLINE_CHARACTERS)}\n… outline truncated …`;
}

function findPreambleEndLine(lines: string[]) {
	let endLine: number | undefined;
	let inBlockComment = false;
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index]!.trim();
		if (inBlockComment) {
			if (text.includes("*/")) inBlockComment = false;
			continue;
		}
		if (text.startsWith("/*")) {
			inBlockComment = !text.includes("*/");
			continue;
		}
		if (text === "" || text.startsWith("//")) continue;
		if (text.startsWith("import ") || /^export\s+.*\sfrom\s/.test(text)) {
			endLine = index + 1;
			continue;
		}
		break;
	}
	return endLine;
}

function scanSourceImports(source: ChunkableSource) {
	const loader = astLanguage(source.path);
	if (!loader) return [];
	try {
		return new Bun.Transpiler({ loader })
			.scanImports(source.content)
			.filter(item => item.kind === "import-statement" || item.kind === "require-call")
			.map(item => item.path);
	} catch {
		return [];
	}
}

function astLanguage(path: string) {
	switch (extname(path)) {
		case ".ts":
		case ".mts":
		case ".cts":
			return "ts";
		case ".tsx":
			return "tsx";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "js";
		case ".jsx":
			return "jsx";
		default:
			return undefined;
	}
}

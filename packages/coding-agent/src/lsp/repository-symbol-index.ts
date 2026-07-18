import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SymbolKind } from "./types";
import { hasGlobPattern, symbolKindToIcon } from "./utils";

export type GeneratedSymbolPolicy = "compact" | "include" | "exclude";
export type RepositorySymbolScope = "top-level" | "all";

export interface RepositorySymbolServer {
	name: string;
	cacheKey: string;
}

export interface RepositorySymbol {
	name: string;
	kind: SymbolKind;
	line: number;
	detail?: string;
	children: RepositorySymbol[];
}

export interface RepositorySymbolFile {
	path: string;
	generated: boolean;
	lines: string[];
	totalSymbols: number;
	shownSymbols: number;
}

export interface RepositorySymbolIndexStats {
	discoveredFiles: number;
	indexedFiles: number;
	metadataHits: number;
	hashHits: number;
	refreshedFiles: number;
	generatedFiles: number;
	skippedGeneratedFiles: number;
	truncatedFiles: number;
	truncatedByFileLimit: boolean;
	truncatedBySymbolLimit: boolean;
}

export interface RepositorySymbolIndexResult {
	target: string;
	scope: RepositorySymbolScope;
	files: RepositorySymbolFile[];
	serverNames: string[];
	stats: RepositorySymbolIndexStats;
}

export interface BuildRepositorySymbolIndexOptions {
	cwd: string;
	target: string;
	maxSymbols: number;
	maxSymbolsPerFile: number;
	generatedPolicy: GeneratedSymbolPolicy;
	scope: RepositorySymbolScope;
	signal?: AbortSignal;
	resolveServer(filePath: string): RepositorySymbolServer | null;
	loadSymbols(filePath: string): Promise<unknown>;
}

interface CachedSymbolFile {
	mtimeMs: number;
	size: number;
	hash: string;
	serverKey: string;
	generated: boolean;
	symbols: RepositorySymbol[] | null;
}

interface FlattenedSymbols {
	lines: string[];
	total: number;
}

export const DEFAULT_REPOSITORY_SYMBOL_LIMIT = 4_000;
export const DEFAULT_REPOSITORY_SYMBOLS_PER_FILE = 200;

const MAX_REPOSITORY_SYMBOL_FILES = 2_000;
const DEFAULT_GENERATED_SYMBOL_LIMIT = 40;
const GENERATED_SYMBOL_DEPTH = 1;
const GENERATED_PATH_PATTERN = /(?:^|\/)(?:generated|gen|[^/]+-gen)(?:\/|$)|(?:\.generated|\.g)\.[^/]+$/i;
const GENERATED_HEADER_PATTERN = /@generated|code generated|generated code|do not edit/i;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSymbolKind(value: unknown): value is SymbolKind {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 26;
}

function readSymbolLine(value: Record<string, unknown>): number | null {
	const directRange = value.range;
	if (isRecord(directRange) && isRecord(directRange.start) && typeof directRange.start.line === "number") {
		return directRange.start.line + 1;
	}
	const location = value.location;
	if (
		isRecord(location) &&
		isRecord(location.range) &&
		isRecord(location.range.start) &&
		typeof location.range.start.line === "number"
	) {
		return location.range.start.line + 1;
	}
	return null;
}

function parseSymbol(value: unknown): RepositorySymbol {
	if (!isRecord(value)) throw new Error("LSP documentSymbol returned a non-object symbol");
	if (typeof value.name !== "string") throw new Error("LSP documentSymbol returned a symbol without a name");
	if (!isSymbolKind(value.kind)) throw new Error(`LSP documentSymbol returned an invalid kind for ${value.name}`);
	const line = readSymbolLine(value);
	if (line === null) throw new Error(`LSP documentSymbol returned no source range for ${value.name}`);
	if (value.detail !== undefined && typeof value.detail !== "string") {
		throw new Error(`LSP documentSymbol returned an invalid detail for ${value.name}`);
	}
	if (value.children !== undefined && !Array.isArray(value.children)) {
		throw new Error(`LSP documentSymbol returned invalid children for ${value.name}`);
	}
	const children = value.children?.map(parseSymbol) ?? [];
	return value.detail === undefined
		? { name: value.name, kind: value.kind, line, children }
		: { name: value.name, kind: value.kind, line, detail: value.detail, children };
}

export function parseDocumentSymbolResponse(value: unknown): RepositorySymbol[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("LSP documentSymbol returned a non-array response");
	return value.map(parseSymbol);
}

function countSymbols(symbols: RepositorySymbol[]): number {
	let count = 0;
	for (const symbol of symbols) {
		count += 1 + countSymbols(symbol.children);
	}
	return count;
}

function flattenSymbols(symbols: RepositorySymbol[], maxDepth: number): FlattenedSymbols {
	const lines: string[] = [];
	let total = 0;
	const visit = (items: RepositorySymbol[], depth: number): void => {
		for (const symbol of items) {
			total += 1;
			const prefix = "  ".repeat(depth);
			const detail = symbol.detail ? ` ${symbol.detail}` : "";
			lines.push(`${prefix}${symbolKindToIcon(symbol.kind)} ${symbol.name}${detail} @ line ${symbol.line}`);
			if (depth < maxDepth) visit(symbol.children, depth + 1);
		}
	};
	visit(symbols, 0);
	return { lines, total };
}

function hasIgnoredDirectory(filePath: string): boolean {
	return filePath.split(path.sep).some(segment => IGNORED_DIRECTORY_NAMES.has(segment));
}

function normalizeGlobTarget(target: string, cwd: string): string {
	if (!path.isAbsolute(target)) return target;
	const relative = path.relative(cwd, target);
	if (relative.startsWith(`..${path.sep}`) || relative === "..") {
		throw new Error("Repository symbol globs must stay within the working directory");
	}
	return relative;
}

export async function isRepositorySymbolTarget(target: string, cwd: string): Promise<boolean> {
	if (hasGlobPattern(target)) return true;
	try {
		return (await fs.stat(path.resolve(cwd, target))).isDirectory();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function collectTargetFiles(target: string, cwd: string): Promise<{ files: string[]; truncated: boolean }> {
	const resolvedTarget = path.resolve(cwd, target);
	if (!hasGlobPattern(target)) {
		try {
			const stat = await fs.stat(resolvedTarget);
			if (stat.isFile()) return { files: [resolvedTarget], truncated: false };
			if (!stat.isDirectory()) return { files: [], truncated: false };
			const files: string[] = [];
			for await (const match of new Bun.Glob("**/*").scan({ cwd: resolvedTarget, onlyFiles: true })) {
				const filePath = path.join(resolvedTarget, match);
				if (hasIgnoredDirectory(path.relative(resolvedTarget, filePath))) continue;
				if (files.length >= MAX_REPOSITORY_SYMBOL_FILES) return { files, truncated: true };
				files.push(filePath);
			}
			return { files: files.sort(), truncated: false };
		} catch (error) {
			if (isEnoent(error)) return { files: [], truncated: false };
			throw error;
		}
	}

	const files: string[] = [];
	const pattern = normalizeGlobTarget(target, cwd);
	for await (const match of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
		const filePath = path.resolve(cwd, match);
		if (hasIgnoredDirectory(path.relative(cwd, filePath))) continue;
		if (files.length >= MAX_REPOSITORY_SYMBOL_FILES) return { files, truncated: true };
		files.push(filePath);
	}
	return { files: files.sort(), truncated: false };
}

function isGeneratedFile(filePath: string, cwd: string, content: string): boolean {
	const relativePath = path.relative(cwd, filePath).split(path.sep).join("/");
	return GENERATED_PATH_PATTERN.test(relativePath) || GENERATED_HEADER_PATTERN.test(content.slice(0, 1_024));
}

function contentHash(content: string): string {
	return Bun.hash.wyhash(content).toString(16);
}

function clampLimit(value: number, maximum: number): number {
	return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

export class RepositorySymbolIndex {
	readonly #entries = new Map<string, CachedSymbolFile>();

	clear(): void {
		this.#entries.clear();
	}

	async build(options: BuildRepositorySymbolIndexOptions): Promise<RepositorySymbolIndexResult> {
		const targetFiles = await collectTargetFiles(options.target, options.cwd);
		const stats: RepositorySymbolIndexStats = {
			discoveredFiles: targetFiles.files.length,
			indexedFiles: 0,
			metadataHits: 0,
			hashHits: 0,
			refreshedFiles: 0,
			generatedFiles: 0,
			skippedGeneratedFiles: 0,
			truncatedFiles: 0,
			truncatedByFileLimit: targetFiles.truncated,
			truncatedBySymbolLimit: false,
		};
		const indexed: Array<{ filePath: string; entry: CachedSymbolFile }> = [];
		const serverNames = new Set<string>();

		for (const filePath of targetFiles.files) {
			if (options.signal?.aborted) {
				throw options.signal.reason instanceof Error
					? options.signal.reason
					: new Error("Repository symbol index aborted");
			}
			const server = options.resolveServer(filePath);
			if (!server) continue;
			serverNames.add(server.name);
			const stat = await fs.stat(filePath);
			const cached = this.#entries.get(filePath);
			let entry: CachedSymbolFile;

			if (
				cached &&
				cached.serverKey === server.cacheKey &&
				cached.mtimeMs === stat.mtimeMs &&
				cached.size === stat.size
			) {
				entry = cached;
				stats.metadataHits += 1;
			} else {
				const content = await Bun.file(filePath).text();
				const hash = contentHash(content);
				if (cached && cached.serverKey === server.cacheKey && cached.hash === hash) {
					entry = { ...cached, mtimeMs: stat.mtimeMs, size: stat.size };
					stats.hashHits += 1;
				} else {
					entry = {
						mtimeMs: stat.mtimeMs,
						size: stat.size,
						hash,
						serverKey: server.cacheKey,
						generated: isGeneratedFile(filePath, options.cwd, content),
						symbols: null,
					};
				}
			}

			if (entry.generated) stats.generatedFiles += 1;
			if (entry.generated && options.generatedPolicy === "exclude") {
				stats.skippedGeneratedFiles += 1;
				this.#entries.set(filePath, entry);
				continue;
			}
			if (entry.symbols === null) {
				entry = { ...entry, symbols: parseDocumentSymbolResponse(await options.loadSymbols(filePath)) };
				stats.refreshedFiles += 1;
			}
			this.#entries.set(filePath, entry);
			if (entry.symbols !== null) indexed.push({ filePath, entry });
			if (entry.symbols !== null) stats.indexedFiles += 1;
		}

		const files: RepositorySymbolFile[] = [];
		let remainingSymbols = clampLimit(options.maxSymbols, 100_000);
		const normalFileLimit = clampLimit(options.maxSymbolsPerFile, 10_000);
		for (const { filePath, entry } of indexed) {
			if (remainingSymbols <= 0) {
				stats.truncatedBySymbolLimit = true;
				break;
			}
			const generatedCompact = options.scope === "all" && entry.generated && options.generatedPolicy === "compact";
			const perFileLimit = generatedCompact
				? Math.min(normalFileLimit, DEFAULT_GENERATED_SYMBOL_LIMIT)
				: normalFileLimit;
			if (entry.symbols === null) continue;
			const maxDepth = options.scope === "top-level" ? 0 : generatedCompact ? GENERATED_SYMBOL_DEPTH : Infinity;
			const flattened = flattenSymbols(entry.symbols, maxDepth);
			const totalSymbols = options.scope === "all" ? countSymbols(entry.symbols) : flattened.total;
			const symbolsAvailableForFile = Math.min(flattened.lines.length, perFileLimit);
			const shownSymbols = Math.min(symbolsAvailableForFile, remainingSymbols);
			if (shownSymbols < totalSymbols) stats.truncatedFiles += 1;
			if (shownSymbols < symbolsAvailableForFile) stats.truncatedBySymbolLimit = true;
			files.push({
				path: path.relative(options.cwd, filePath) || path.basename(filePath),
				generated: entry.generated,
				lines: flattened.lines.slice(0, shownSymbols),
				totalSymbols,
				shownSymbols,
			});
			remainingSymbols -= shownSymbols;
		}
		if (indexed.length > files.length) stats.truncatedBySymbolLimit = true;

		return {
			target: options.target,
			files,
			serverNames: [...serverNames].sort(),
			scope: options.scope,
			stats,
		};
	}
}

export function formatRepositorySymbolIndex(result: RepositorySymbolIndexResult): string {
	const { stats } = result;
	const cacheHits = stats.metadataHits + stats.hashHits;
	const summary = [
		`${stats.indexedFiles}/${stats.discoveredFiles} files indexed`,
		`${stats.refreshedFiles} refreshed`,
		`${result.scope} scope`,
		`${cacheHits} cache hits`,
		`${stats.generatedFiles} generated`,
	];
	if (stats.skippedGeneratedFiles > 0) summary.push(`${stats.skippedGeneratedFiles} generated skipped`);
	if (stats.truncatedFiles > 0) summary.push(`${stats.truncatedFiles} files truncated`);
	if (stats.truncatedByFileLimit) summary.push("file limit reached");
	if (stats.truncatedBySymbolLimit) summary.push("symbol limit reached");

	const blocks = result.files.flatMap(file => {
		if (file.lines.length === 0) return [];
		const generated = file.generated ? " [generated]" : "";
		const omitted = file.totalSymbols - file.shownSymbols;
		const truncation = omitted > 0 ? [`  […${omitted} symbols elided…]`] : [];
		return [`${file.path}${generated}:`, ...file.lines.map(line => `  ${line}`), ...truncation];
	});
	const body = blocks.length > 0 ? blocks.join("\n") : "No symbols found";
	return `Repository symbols in ${result.target} (${summary.join("; ")}):\n${body}`;
}

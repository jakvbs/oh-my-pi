import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	formatRepositorySymbolIndex,
	RepositorySymbolIndex,
	type RepositorySymbolServer,
} from "@oh-my-pi/pi-coding-agent/lsp/repository-symbol-index";
import { TempDir } from "@oh-my-pi/pi-utils";

const SERVER: RepositorySymbolServer = { name: "typescript", cacheKey: "typescript:test" };

function documentSymbol(name: string, line = 0, children?: unknown[]): Record<string, unknown> {
	return {
		name,
		kind: 12,
		range: {
			start: { line, character: 0 },
			end: { line, character: name.length },
		},
		selectionRange: {
			start: { line, character: 0 },
			end: { line, character: name.length },
		},
		children,
	};
}

function serverForTypeScript(filePath: string): RepositorySymbolServer | null {
	return filePath.endsWith(".ts") ? SERVER : null;
}

describe("RepositorySymbolIndex", () => {
	it("reuses metadata and content hashes while refreshing only changed files", async () => {
		const tempDir = TempDir.createSync("@omp-repository-symbol-index-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			const alphaPath = path.join(srcDir, "alpha.ts");
			const betaPath = path.join(srcDir, "beta.ts");
			await Bun.write(alphaPath, "export function alpha() {}\n");
			await Bun.write(betaPath, "export function beta() {}\n");
			const loads = new Map<string, number>();
			const index = new RepositorySymbolIndex();
			const build = () =>
				index.build({
					cwd: tempDir.path(),
					target: "src",
					maxSymbols: 100,
					maxSymbolsPerFile: 20,
					generatedPolicy: "compact",
					scope: "all",
					resolveServer: serverForTypeScript,
					loadSymbols: filePath => {
						loads.set(filePath, (loads.get(filePath) ?? 0) + 1);
						return Promise.resolve([documentSymbol(path.basename(filePath, ".ts"))]);
					},
				});

			const first = await build();
			expect(first.stats.refreshedFiles).toBe(2);
			expect(first.stats.metadataHits).toBe(0);
			expect(loads.get(alphaPath)).toBe(1);
			expect(loads.get(betaPath)).toBe(1);

			const second = await build();
			expect(second.stats.refreshedFiles).toBe(0);
			expect(second.stats.metadataHits).toBe(2);

			const alphaStat = await fs.stat(alphaPath);
			const touchedAt = new Date(alphaStat.mtimeMs + 1_000);
			await fs.utimes(alphaPath, touchedAt, touchedAt);
			const touched = await build();
			expect(touched.stats.hashHits).toBe(1);
			expect(touched.stats.metadataHits).toBe(1);
			expect(touched.stats.refreshedFiles).toBe(0);

			await Bun.write(betaPath, "export function betaChanged() {}\n");
			const changed = await build();
			expect(changed.stats.refreshedFiles).toBe(1);
			expect(loads.get(alphaPath)).toBe(1);
			expect(loads.get(betaPath)).toBe(2);
		} finally {
			tempDir.removeSync();
		}
	});

	it("applies generated policies across cached builds and enforces limits", async () => {
		const tempDir = TempDir.createSync("@omp-repository-symbol-generated-");
		try {
			const generatedPath = path.join(tempDir.path(), "src", "api-gen", "types.ts");
			await Bun.write(generatedPath, "export class Generated {}\n");
			const symbols = [documentSymbol("Generated", 0, [documentSymbol("method", 1, [documentSymbol("local", 2)])])];
			const index = new RepositorySymbolIndex();
			const compact = await index.build({
				cwd: tempDir.path(),
				target: "src/**/*.ts",
				maxSymbols: 10,
				maxSymbolsPerFile: 10,
				generatedPolicy: "compact",
				scope: "all",
				resolveServer: serverForTypeScript,
				loadSymbols: () => Promise.resolve(symbols),
			});

			expect(compact.stats.generatedFiles).toBe(1);
			expect(compact.files[0]?.lines).toHaveLength(2);
			expect(compact.files[0]?.totalSymbols).toBe(3);
			expect(compact.files[0]?.lines.join("\n")).not.toContain("local");
			expect(formatRepositorySymbolIndex(compact)).toContain("[…1 symbols elided…]");

			const included = await index.build({
				cwd: tempDir.path(),
				target: "src/**/*.ts",
				maxSymbols: 2,
				maxSymbolsPerFile: 10,
				generatedPolicy: "include",
				scope: "all",
				resolveServer: serverForTypeScript,
				loadSymbols: () => Promise.resolve(symbols),
			});
			expect(included.stats.metadataHits).toBe(1);
			expect(included.stats.truncatedBySymbolLimit).toBe(true);
			expect(included.files[0]?.shownSymbols).toBe(2);

			const excluded = await index.build({
				cwd: tempDir.path(),
				target: "src/**/*.ts",
				maxSymbols: 10,
				maxSymbolsPerFile: 10,
				generatedPolicy: "exclude",
				scope: "all",
				resolveServer: serverForTypeScript,
				loadSymbols: () => Promise.resolve(symbols),
			});
			expect(excluded.stats.metadataHits).toBe(1);
			expect(excluded.stats.skippedGeneratedFiles).toBe(1);
			expect(excluded.files).toEqual([]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("returns only root symbols for top-level scope and reuses them for all scope", async () => {
		const tempDir = TempDir.createSync("@omp-repository-symbol-scope-");
		try {
			await Bun.write(path.join(tempDir.path(), "src", "api.ts"), "export class Api {}\n");
			const symbols = [documentSymbol("Api", 0, [documentSymbol("method", 1, [documentSymbol("local", 2)])])];
			const index = new RepositorySymbolIndex();
			const build = (scope: "top-level" | "all") =>
				index.build({
					cwd: tempDir.path(),
					target: "src",
					maxSymbols: 10,
					maxSymbolsPerFile: 10,
					generatedPolicy: "include",
					scope,
					resolveServer: serverForTypeScript,
					loadSymbols: () => Promise.resolve(symbols),
				});

			const topLevel = await build("top-level");
			expect(topLevel.files[0]?.lines).toHaveLength(1);
			expect(topLevel.files[0]?.lines[0]).toContain("Api");
			expect(topLevel.files[0]?.totalSymbols).toBe(1);
			expect(formatRepositorySymbolIndex(topLevel)).not.toContain("method");

			const all = await build("all");
			expect(all.stats.metadataHits).toBe(1);
			expect(all.files[0]?.lines).toHaveLength(3);
			expect(formatRepositorySymbolIndex(all)).toContain("local");
		} finally {
			tempDir.removeSync();
		}
	});

	it("skips generated files without asking the language server", async () => {
		const tempDir = TempDir.createSync("@omp-repository-symbol-exclude-");
		try {
			await Bun.write(path.join(tempDir.path(), "generated", "api.ts"), "// Code generated; DO NOT EDIT.\n");
			let loads = 0;
			const result = await new RepositorySymbolIndex().build({
				cwd: tempDir.path(),
				target: "generated",
				maxSymbols: 10,
				maxSymbolsPerFile: 10,
				generatedPolicy: "exclude",
				scope: "all",
				resolveServer: serverForTypeScript,
				loadSymbols: () => {
					loads += 1;
					return Promise.resolve([]);
				},
			});

			expect(loads).toBe(0);
			expect(result.stats.skippedGeneratedFiles).toBe(1);
			expect(result.files).toEqual([]);
		} finally {
			tempDir.removeSync();
		}
	});
});

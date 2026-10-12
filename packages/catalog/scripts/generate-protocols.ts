import * as path from "node:path";
import { generateProtoTs, ProtoContext, parseProto } from "./proto-parser";

const PACKAGES_DIR = path.resolve(import.meta.dir, "../..");
const CURSOR_PROTO = path.join(PACKAGES_DIR, "ai/src/providers/cursor/proto/agent.proto");
const CURSOR_MODELS_PROTO = path.join(PACKAGES_DIR, "catalog/src/discovery/cursor-models.proto");
const DISCOVERY_DIR = path.resolve(import.meta.dir, "../src/discovery");

const CURSOR_CONSUMER_DIRS = [
	path.join(PACKAGES_DIR, "ai/src"),
	path.join(PACKAGES_DIR, "ai/test"),
	path.join(PACKAGES_DIR, "catalog/src"),
	path.join(PACKAGES_DIR, "catalog/test"),
	path.join(PACKAGES_DIR, "coding-agent/test"),
];

const CURSOR_ENUMS = [
	"CursorError",
	"CursorRuleSource",
	"ForceBackgroundShellStatus",
	"ForceBackgroundSubagentStatus",
	"ModelVendorId",
];
async function collectCursorMessages(): Promise<string[]> {
	const symbols = new Set<string>();
	const importPattern = /import(?:\s+type)?\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];/g;
	const sourceFiles = await collectTypeScriptFiles(CURSOR_CONSUMER_DIRS);

	for (const sourceFile of sourceFiles) {
		const source = await Bun.file(sourceFile).text();
		for (const match of source.matchAll(importPattern)) {
			const modulePath = match[2];
			if (!modulePath.endsWith("cursor-proto")) continue;
			for (const specifier of match[1].split(",")) {
				const symbol = specifier
					.trim()
					.replace(/^type\s+/, "")
					.replace(/\s+as\s+.+$/, "");
				if (!symbol) continue;
				symbols.add(symbol.endsWith("Schema") ? symbol.slice(0, -6) : symbol);
			}
		}
	}

	for (const enumName of CURSOR_ENUMS) symbols.delete(enumName);
	if (symbols.size === 0) throw new Error("No Cursor protocol consumers found");
	return [...symbols].sort();
}

async function collectTypeScriptFiles(directories: string[]): Promise<string[]> {
	const files: string[] = [];
	const glob = new Bun.Glob("**/*.ts");
	for (const directory of directories) {
		for await (const relativePath of glob.scan({ cwd: directory, onlyFiles: true })) {
			files.push(path.join(directory, relativePath));
		}
	}
	return files.sort();
}

async function generateProtocols(): Promise<void> {
	const cursorSource = await Bun.file(CURSOR_PROTO).text();
	const cursorModelsSource = await Bun.file(CURSOR_MODELS_PROTO).text();
	const cursorContext = new ProtoContext();
	cursorContext.addFile(parseProto(cursorSource, "agent.proto"));
	cursorContext.addFile(parseProto(cursorModelsSource, "cursor-models.proto"));

	const cursor = generateProtoTs(cursorContext, {
		includeMessages: await collectCursorMessages(),
		includeEnums: CURSOR_ENUMS,
		includeDependencies: true,
		packagePrefix: "Cursor agent",
		protobufImportPath: "./protobuf",
	});

	await Bun.write(path.join(DISCOVERY_DIR, "cursor-proto.ts"), `${cursor}\n`);
}

await generateProtocols();

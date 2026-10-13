/**
 * Protocol handler for history:// URLs.
 *
 * Exposes session transcripts as concise markdown. Live sessions in the
 * `AgentRegistry` render from the in-memory message array. Transcripts that are
 * not live (an earlier session's artifacts directory) load read-only from the
 * on-disk `<id>.jsonl` — no writer, no lock.
 *
 * URL forms:
 * - history:// - Index of all registered + on-disk transcripts
 * - history://<agentId> - Concise markdown transcript of that session
 * - history://current/full - Full, caller-bound current branch history (experimental)
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import {
	bashExecutionToText,
	pythonExecutionToText,
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
} from "../session/messages";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import type { SessionEntry } from "../session/session-entries";
import historyPromptDoc from "../prompts/internal-urls/history.md" with { type: "text" };
import { artifactsDirsFromRegistry, sessionFilesFromDisk } from "./registry-helpers";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/**
 * On-disk transcript ids for `complete()`, keyed by the scanned dir set.
 * Completion runs per keystroke and the scan is recursive, so a short reuse
 * window replaces a full rescan on every key.
 */
const completionDiskIds = new LRUCache<string, Promise<string[]>>({ max: 8, ttl: 2000 });

function diskIdsForCompletion(): Promise<string[]> {
	const key = artifactsDirsFromRegistry().join("\0");
	const cached = completionDiskIds.get(key);
	if (cached) return cached;
	const ids = sessionFilesFromDisk().then(files => [...files.keys()]);
	completionDiskIds.set(key, ids);
	ids.catch(() => completionDiskIds.delete(key));
	return ids;
}

/** True for `history://current/<path>`; throws unless the route is exactly `current/full`. */
function isCurrentFullRoute(url: InternalUrl): boolean {
	const agentId = url.rawHost || url.hostname;
	if (agentId.toLowerCase() !== "current" || !url.pathname || url.pathname === "/") return false;
	if (url.pathname !== "/full" || url.search || url.hash) {
		throw new Error("Invalid history://current route; use exactly history://current/full (selectors may follow it)");
	}
	return true;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
}

function jsonFence(text: string): string {
	let longestBacktickRun = 0;
	for (const match of text.matchAll(/`+/g)) {
		longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
	}
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}json\n${text}\n${fence}`;
}

function appendTextContent(lines: string[], content: string | readonly { type: string; text?: string }[]): void {
	if (typeof content === "string") {
		lines.push(content);
		return;
	}
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") lines.push(block.text);
		else if (block.type === "image") lines.push("[image]");
	}
}

function appendRawMessage(lines: string[], message: AgentMessage): void {
	switch (message.role) {
		case "user":
		case "developer":
			lines.push(`### ${message.role}`);
			appendTextContent(lines, message.content);
			return;
		case "assistant": {
			const assistantMessage = message as AssistantMessage;
			lines.push("### assistant");
			for (const block of assistantMessage.content) {
				if (block.type === "text") lines.push(block.text);
				else if (block.type === "thinking") lines.push("<thinking>", block.thinking, "</thinking>");
				else if (block.type === "toolCall") {
					lines.push(`#### tool call: ${block.name} (${block.id})`);
					lines.push(jsonFence(JSON.stringify(block.arguments, null, 2) ?? "null"));
				} else if (block.type === "redactedThinking") {
					// Opaque provider-encrypted reasoning: keep a marker for the
					// block's presence, not the undecipherable blob.
					lines.push(`[redacted thinking: ${block.data.length} chars omitted]`);
				} else if (block.type === "anthropicServerTool") {
					// Serialize the complete retained server block. Reconstructing a
					// projected subset silently drops metadata (e.g. `caller`) that
					// recovery may need, and server-side search results can hold the
					// only copy of research from before the rollover.
					lines.push(`#### server tool: ${block.block.type}`);
					lines.push(jsonFence(JSON.stringify(block.block, null, 2) ?? "null"));
				} else if (block.type === "image") {
					// Metadata only: base64 bytes are not recoverable text and would
					// dominate the rendered history.
					lines.push(`[image: ${block.mimeType}, ${block.data.length} base64 chars omitted]`);
				} else if (block.type === "fallback") {
					lines.push(`[provider fallback: ${block.from.model} to ${block.to.model}]`);
				}
			}
			return;
		}
		case "toolResult":
			lines.push(`### tool result: ${message.toolName} (${message.toolCallId})${message.isError ? " [error]" : ""}`);
			appendTextContent(lines, message.content);
			return;
		case "bashExecution": {
			const bashMessage = message as BashExecutionMessage;
			lines.push(
				"### bash execution",
				bashExecutionToText(bashMessage),
				jsonFence(
					JSON.stringify(
						{
							exitCode: bashMessage.exitCode,
							cancelled: bashMessage.cancelled,
							truncated: bashMessage.truncated,
							meta: bashMessage.meta,
							imageCount: bashMessage.images?.length ?? 0,
						},
						null,
						2,
					) ?? "null",
				),
			);
			return;
		}
		case "pythonExecution": {
			const pythonMessage = message as PythonExecutionMessage;
			lines.push(
				"### python execution",
				pythonExecutionToText(pythonMessage),
				jsonFence(
					JSON.stringify(
						{
							exitCode: pythonMessage.exitCode,
							cancelled: pythonMessage.cancelled,
							truncated: pythonMessage.truncated,
							meta: pythonMessage.meta,
						},
						null,
						2,
					) ?? "null",
				),
			);
			return;
		}
		case "custom":
		case "hookMessage": {
			const customMessage = message as CustomMessage | HookMessage;
			lines.push(`### ${customMessage.role} (${customMessage.customType})`);
			appendTextContent(lines, customMessage.content);
			return;
		}
		case "branchSummary": {
			const branchSummary = message as BranchSummaryMessage;
			lines.push(`### branch summary (from ${branchSummary.fromId})`, branchSummary.summary);
			return;
		}
		case "compactionSummary": {
			const compactionSummary = message as CompactionSummaryMessage;
			lines.push(
				`### compaction summary (${compactionSummary.tokensBefore} tokens before)`,
				compactionSummary.summary,
			);
			return;
		}
		case "fileMention": {
			const fileMention = message as FileMentionMessage;
			lines.push("### file mention");
			for (const file of fileMention.files) {
				lines.push(`<file path="${file.path}">`);
				if (file.content) lines.push(file.content);
				if (file.image) lines.push("[image]");
				lines.push("</file>");
			}
			return;
		}
		default:
			lines.push(jsonFence(JSON.stringify(message, null, 2) ?? "null"));
			return;
	}
}

function renderRawEntry(lines: string[], entry: SessionEntry): void {
	lines.push(
		`## Entry ${entry.id} · ${entry.type}`,
		"",
		`Parent: ${entry.parentId ?? "root"}`,
		`Timestamp: ${entry.timestamp}`,
		"",
	);
	if (entry.type === "message") {
		appendRawMessage(lines, entry.message);
		return;
	}
	if (entry.type === "compaction") {
		lines.push(
			"> Context window boundary: compaction",
			"",
			`First kept entry: ${entry.firstKeptEntryId}`,
			`Tokens before: ${entry.tokensBefore}`,
			"",
			entry.summary,
		);
		return;
	}
	if (entry.type === "reset_boundary") {
		lines.push("> Context window boundary: reset");
		return;
	}
	if (entry.type === "branch_summary") {
		lines.push(`From entry: ${entry.fromId}`, "", entry.summary);
		return;
	}
	lines.push(jsonFence(JSON.stringify(entry, null, 2) ?? "null"));
}

/**
 * Render every persisted entry on the caller's live branch without the
 * compaction filters that shape model context. Each block begins with the
 * durable session-entry id, making references unambiguous across compactions
 * and branch rewinds.
 */
export function formatCurrentBranchFullHistory(entries: readonly SessionEntry[]): string {
	const lines = [
		"# Current branch — full history",
		"",
		"Source: caller-bound live session branch. Context-window boundaries are retained below; this view never uses a registry or on-disk fallback.",
		"",
	];
	for (const entry of entries) {
		renderRawEntry(lines, entry);
		lines.push("");
	}
	return `${lines.join("\n").trim()}\n`;
}

/** The registry refs a lookup was matched against. */
interface RefLookup {
	ref: AgentRef | undefined;
	refs: AgentRef[];
}

/**
 * Handler for history:// URLs.
 *
 * Resolves ids against the global AgentRegistry, then falls back to on-disk
 * `.jsonl` transcripts.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: false, linkable: true };

	promptDoc(): string {
		return historyPromptDoc.trim();
	}

	/**
	 * The JSONL session file the transcript is rendered from. The index and
	 * `history://current/full` render from memory, so they locate to null, as
	 * do live sessions without a session file and unknown ids.
	 */
	async locate(url: InternalUrl): Promise<string | null> {
		if (isCurrentFullRoute(url)) return null;
		const agentId = url.rawHost || url.hostname;
		if (!agentId) return null;
		const { ref } = this.#lookup(agentId);
		if (ref?.sessionFile) return ref.sessionFile;
		if (ref?.session) return null;
		return (await this.#findOnDisk(ref?.id ?? agentId))?.file ?? null;
	}

	/** Find the registry ref for `agentId` (exact, then case-insensitive). */
	#lookup(agentId: string): RefLookup {
		const registry = AgentRegistry.global();
		const refs = registry.list();
		let ref = registry.get(agentId);
		if (!ref) {
			const lower = agentId.toLowerCase();
			ref = refs.find(candidate => candidate.id.toLowerCase() === lower);
		}
		return { ref, refs };
	}

	#resolveCurrentFull(url: InternalUrl, context: ResolveContext | undefined): InternalResource {
		if (!context?.experimentalContextManagement) {
			throw new Error(
				"history://current/full is available only when compaction.experimentalContextManagement is enabled",
			);
		}
		const branch = context.getSessionBranch?.();
		if (!branch) {
			throw new Error("history://current/full requires a bound live session branch");
		}
		const content = formatCurrentBranchFullHistory(branch);
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: ["Source: caller-bound live session branch (full, uncompacted)"],
		};
	}
	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (isCurrentFullRoute(url)) return this.#resolveCurrentFull(url, context);
		const agentId = url.rawHost || url.hostname;
		if (!agentId) {
			const content = await this.#renderIndex(AgentRegistry.global().list());
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const { ref, refs } = this.#lookup(agentId);
		if (!ref) {
			// Registry miss: serve the transcript straight from disk if the session file persists.
			const disk = await this.#resolveFromDisk(agentId);
			if (disk) return { ...disk, url: url.href };

			const known = refs.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown session: ${agentId}\nKnown sessions: ${knownStr}\nList all with history://`);
		}

		const notes: string[] = [];
		let messages: unknown[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push("Source: session file (read-only)");
		} else {
			// No live session and no retained sessionFile — try the disk scan before
			// giving up, in case the transcript lingers under an artifacts dir.
			const disk = await this.#resolveFromDisk(ref.id);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Session ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: ref.id });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	/**
	 * Load a transcript for `agentId` from an on-disk `.jsonl` session file,
	 * matched case-insensitively. Returns `undefined` when no file is found.
	 */
	async #resolveFromDisk(agentId: string): Promise<InternalResource | undefined> {
		const match = await this.#findOnDisk(agentId);
		if (!match) return undefined;
		const messages = await loadSessionMessagesReadOnly(match.file);
		const content = formatSessionHistoryMarkdown(messages, { title: `${match.id} (on disk)` });
		return {
			url: "",
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: match.file,
			notes: ["Source: session file (read-only, unregistered)"],
		};
	}

	/** On-disk `<id>.jsonl` for `agentId`: exact id wins, else the last case-insensitive match. */
	async #findOnDisk(agentId: string): Promise<{ id: string; file: string } | undefined> {
		const files = await sessionFilesFromDisk();
		const lower = agentId.toLowerCase();
		let match: { id: string; file: string } | undefined;
		for (const [id, file] of files) {
			if (id === agentId || id.toLowerCase() === lower) {
				match = { id, file };
				if (id === agentId) break;
			}
		}
		return match;
	}

	async #renderIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({ id: ref.id, status: ref.session ? "live" : "session file" }));
		// Merge on-disk transcripts for sessions absent from the registry.
		const registered = new Set(refs.map(ref => ref.id));
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, status: "on disk" });
		}

		const lines: string[] = ["# Sessions", ""];
		if (entries.length === 0) {
			lines.push("No sessions registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | status |", "|---|---|");
		for (const entry of entries) {
			lines.push(`| ${entry.id} | ${entry.status} |`);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seen = new Set<string>();
		for (const ref of AgentRegistry.global().list()) {
			seen.add(ref.id);
			completions.push({ value: ref.id, description: ref.session ? "live" : "session file" });
		}
		for (const id of await diskIdsForCompletion()) {
			if (seen.has(id)) continue;
			seen.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}

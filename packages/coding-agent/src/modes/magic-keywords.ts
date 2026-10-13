import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };

/**
 * Magic keywords: standalone lowercase prose words in a user prompt that
 * append a hidden, user-attributed notice for that turn and glow in the TUI.
 *
 * This table is the single source of truth. Every downstream surface derives
 * from it: the `magicKeywords.<id>` settings (`modes/settings.ts`), the notice
 * injection and `<id>-notice` message types (agent-session, queued-messages),
 * and the editor/bubble gradients (`setMagicKeywords` in pi-tui). Adding a
 * keyword means one row here plus its notice template under `prompts/system/`.
 */

/** One magic keyword: trigger word, gradient, settings copy, and the notice it injects. */
export interface MagicKeyword {
	/** Settings key suffix (`magicKeywords.<id>`) and notice message type prefix (`<id>-notice`). */
	id: string;
	/** Exact lowercase trigger, matched only as standalone prose. */
	word: string;
	/** Editor/bubble gradient as an HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap. */
	hue: readonly [number, number];
	/** Settings panel label. */
	label: string;
	/** Settings panel description. */
	description: string;
	/** Render the hidden notice queued ahead of the user message. */
	notice: () => string;
}

/** Hidden notice for "ultrathink": careful multi-step reasoning. */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

export const MAGIC_KEYWORDS = [
	{
		id: "ultrathink",
		word: "ultrathink",
		hue: [0, 330],
		label: "Ultrathink Keyword",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		notice: () => ULTRATHINK_NOTICE,
	},
] as const satisfies readonly MagicKeyword[];

/** Settings key suffix of a registered keyword. */
export type MagicKeywordId = (typeof MAGIC_KEYWORDS)[number]["id"];

/** Hidden custom-message type carrying a keyword's notice. */
export type MagicKeywordNoticeType = `${MagicKeywordId}-notice`;

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: Date.now(),
	};
}

function createContext(options: {
	editorText: string;
	optimisticSignature?: string;
	locallySubmittedSignatures?: string[];
	pendingImages?: ImageContent[];
}) {
	let currentEditorText = options.editorText;
	const setText = vi.fn((text: string) => {
		currentEditorText = text;
	});
	const editor = {
		setText,
		getText: () => currentEditorText,
		pendingImages: [...(options.pendingImages ?? [])],
	};
	const ctx = createInteractiveModeContext({
		editor,
		optimisticUserMessageSignature: options.optimisticSignature,
		locallySubmittedUserSignatures: new Set<string>(options.locallySubmittedSignatures ?? []),
	});
	const clearOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	const replaceOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	ctx.clearOptimisticUserMessage = clearOptimisticUserMessage;
	ctx.replaceOptimisticUserMessage = replaceOptimisticUserMessage;
	return {
		ctx,
		editor,
		setText,
		addMessageToChat: ctx.addMessageToChat,
		updatePendingMessagesDisplay: ctx.updatePendingMessagesDisplay,
		clearOptimisticUserMessage,
		replaceOptimisticUserMessage,
	};
}

describe("EventController message_start (user role)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an in-progress editor draft when delivering a queued submission", async () => {
		// Reproduces the bug: user sends a message during streaming (queued) and then
		// types a follow-up draft. When the queue drains and message_start fires,
		// the editor MUST keep the draft.
		const message = createUserMessage("queued during streaming");
		const signature = "queued during streaming\u00000";
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "draft typed after queuing",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft typed after queuing");
		// Queued message was not optimistically rendered, so it must still land in chat.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// Pending list always refreshes so the dequeued entry disappears.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Signature is consumed so a future external message with the same shape is
		// not matched to this local submission again. The composer is never cleared
		// on message_start, so consumption no longer affects the draft.
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("preserves the in-progress draft for a user message from an extension", async () => {
		// Regression: a user message this session never submitted locally is a real,
		// non-synthetic prompt (an extension delivering `sendUserMessage`, e.g. HCOM).
		// "Not local" must not mean "reset the editor": the draft being typed — text
		// and pasted images — has to survive the delivery.
		const message = createUserMessage("inbound from an extension");
		const draftImage: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "hello",
			pendingImages: [draftImage],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("hello");
		expect(editor.pendingImages).toEqual([draftImage]);
		// The inbound message still reaches the transcript.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// The pending list still refreshes.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("preserves the editor for an optimistic submission and skips the duplicate chat add", async () => {
		// Optimistic path already added the user message to chat and cleared the
		// editor at submit time. message_start must not re-add or re-clear.
		const message = createUserMessage("optimistic send");
		const signature = "optimistic send\u00000";
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "",
			optimisticSignature: signature,
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
	});

	it("appends a queued image submission synchronously so later events cannot reorder it", async () => {
		// Regression (da636e3f5): AgentSession.#emit dispatches listeners fire-and-forget,
		// so an await between the user message_start and addMessageToChat lets the next
		// synchronously-handled events (assistant message_start, tool execution start/end)
		// append their components first — dropping the user bubble *below* the very tool
		// output it was sent to steer. The append must happen before the handler settles.
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "steer mid-stream" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};
		const signature = "steer mid-stream\u00001";
		const { ctx, addMessageToChat } = createContext({
			editorText: "",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		// Fire WITHOUT awaiting: the bubble must already be appended synchronously.
		const pending = controller.handleEvent({ type: "message_start", message }).catch(() => {});
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		await pending;
	});
});

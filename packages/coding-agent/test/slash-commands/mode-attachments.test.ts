import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";

type Attachments = Pick<SubmittedUserInput, "images" | "imageLinks">;

function createHarness(
	inputResult: { images?: ImageContent[]; text?: string } | Promise<{ images?: ImageContent[]; text?: string }>,
) {
	const oldImage: ImageContent = { type: "image", data: "b2xk", mimeType: "image/png" };
	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleGuidedGoalCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	let editorText = "";
	const editor = {
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		addToHistory: vi.fn(),
		getText: () => editorText,
		getExpandedText: () => editorText,
		setText(text: string) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text: string) {
			editorText = text;
		},
		pendingImages: [oldImage],
		pendingImageLinks: ["file:///old.png"] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		clearDraft() {
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
			this.imageLinks = undefined;
		},
	};
	const showError = vi.fn();
	const ctx = {
		editor,
		goalModeEnabled: false,
		goalModePaused: false,
		skillCommands: new Map(),
		fileSlashCommands: new Set(),
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				emitInput: vi.fn(async () => inputResult),
				getCommand: () => undefined,
			},
		},
		sessionManager: {
			putBlob: vi.fn(async () => ({ displayPath: "file:///replacement.png" })),
		},
		focusedAgentId: undefined,
		ui: { requestRender: vi.fn() },
		compactionQueuedMessages: [],
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return {
		editor,
		showError,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	};
}

describe("mode command attachments", () => {
	it("uses extension-replaced images and regenerated links", async () => {
		const replacements: ImageContent[] = [{ type: "image", data: "bmV3", mimeType: "image/jpeg" }];
		const harness = createHarness({ images: replacements });

		await harness.editor.onSubmit?.("/goal inspect this");

		const input = harness.handleGoalModeCommand.mock.calls[0]?.[1];
		expect(input?.images).toBe(replacements);
		expect(input?.imageLinks).toEqual(["file:///replacement.png"]);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("does not submit images removed by an extension", async () => {
		const harness = createHarness({ images: [] });

		await harness.editor.onSubmit?.("/goal keep this private");

		expect(harness.handleGoalModeCommand).toHaveBeenCalledWith("keep this private", undefined);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("preserves source links when an extension leaves attachments unchanged", async () => {
		const harness = createHarness({});

		await harness.editor.onSubmit?.("/goal inspect this [Image #1]");

		expect(harness.handleGoalModeCommand).toHaveBeenCalledWith(
			"inspect this [Image #1]",
			expect.objectContaining({ imageLinks: ["file:///old.png"] }),
		);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});
	it("restores attachments when a mode command does not submit", async () => {
		const harness = createHarness({});
		harness.handleGoalModeCommand.mockResolvedValueOnce(false);

		await harness.editor.onSubmit?.("/goal show [Image #1]");

		expect(harness.editor.pendingImages).toHaveLength(1);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
	});

	it("detaches submitted images before awaiting input extensions", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[] }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.editor.onSubmit?.("/goal inspect this [Image #1]");
		if (!submission) throw new Error("expected editor submit handler");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({});
		await submission;

		expect(harness.handleGoalModeCommand.mock.calls[0]?.[1]?.images).toHaveLength(1);
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});
	it("preserves later images when an extension rewrites input into a mode command", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[]; text?: string }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.editor.onSubmit?.("inspect this");
		if (!submission) throw new Error("expected editor submit handler");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({ text: "/goal inspect this" });
		await submission;

		expect(harness.handleGoalModeCommand).toHaveBeenCalled();
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});

	it("restores a failed mode command into an empty editor", async () => {
		const failedGoal = createHarness({});
		failedGoal.handleGoalModeCommand.mockRejectedValueOnce(new Error("goal setup failed"));
		const goalSubmission = failedGoal.editor.onSubmit?.("/goal inspect this [Image #1]");
		if (!goalSubmission) throw new Error("expected editor submit handler");

		await goalSubmission;
		expect(failedGoal.editor.getText()).toBe("/goal inspect this [Image #1]");
		expect(failedGoal.editor.pendingImages).toHaveLength(1);
		expect(failedGoal.editor.pendingImageLinks).toEqual(["file:///old.png"]);
		expect(failedGoal.showError).toHaveBeenCalledWith("goal setup failed");
	});

	it.each([
		["/goal", "handleGoalModeCommand"],
		["/guided-goal", "handleGuidedGoalCommand"],
	] as const)("restores a failed %s beside a later draft, remapping its image markers", async (command, handler) => {
		const harness = createHarness({});
		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness[handler].mockImplementationOnce(async () => {
			harness.editor.setText("later [Image #1]");
			harness.editor.pendingImages = [laterImage];
			harness.editor.pendingImageLinks = ["file:///later.png"];
			throw new Error("setup failed");
		});
		const submission = harness.editor.onSubmit?.(`${command} inspect this [Image #1]`);
		if (!submission) throw new Error("expected editor submit handler");

		await submission;
		expect(harness.editor.getText()).toBe(`${command} inspect this [Image #2]\n\nlater [Image #1]`);
		expect(harness.editor.pendingImages).toHaveLength(2);
		expect(harness.editor.pendingImages[0]).toBe(laterImage);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png", "file:///old.png"]);
		expect(harness.showError).toHaveBeenCalledWith("setup failed");
	});
});

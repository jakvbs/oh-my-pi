import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

const FRAMES = 400;
const WATCH_COMMAND = [
	`for i in $(seq 1 ${FRAMES}); do`,
	"printf 'Refreshing run status every 60 seconds.\\n\\nJOBS\\n';",
	"for j in 1 2 3 4 5 6; do printf '* job %s running (tick %s)\\n' $j $i; done;",
	"done;",
	"printf 'probe result 1500x ok\\n'",
].join(" ");

describe("bash status redraws", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-redraw-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("a truncated redraw log shows the last frame and its result instead of the stale head", async () => {
		let artifacts = 0;
		const session = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => path.join(dir, "session.jsonl"),
			getArtifactsDir: () => dir,
			allocateOutputArtifact: async (toolType: string) => {
				const id = String(++artifacts);
				return { id, path: path.join(dir, `${id}.${toolType}.log`) };
			},
			settings: Settings.isolated({ "bash.autoBackground.enabled": false }),
		} satisfies Partial<ToolSession>;
		const bash = wrapToolWithMetaNotice(new BashTool(session as ToolSession));

		const result = await bash.execute("redraw", { command: WATCH_COMMAND });
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");

		const lastFrame = [
			"Refreshing run status every 60 seconds.",
			"",
			"JOBS",
			...[1, 2, 3, 4, 5, 6].map(job => `* job ${job} running (tick ${FRAMES})`),
			"probe result 1500x ok",
		].join("\n");
		expect(text).toStartWith(`${lastFrame}\n`);
		expect(text).not.toContain("(tick 1)");
		expect(text).toContain(
			"[Earlier redraws of this status output elided; showing the last redraw and what followed it.]",
		);
		const totalLines = FRAMES * 9 + 2;
		expect(text).toContain(`Showing lines ${totalLines - 10}-${totalLines} of ${totalLines}`);
	});
});

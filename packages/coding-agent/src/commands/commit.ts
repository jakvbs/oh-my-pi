/**
 * Generate and optionally push a commit with changelog updates.
 */

import { postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { commitHelp as commandHelp } from "../cli/command-help";
import { CommitAbortedError, runCommitCommand } from "../commit";
import type { CommitCommandArgs } from "../commit/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Commit extends Command {
	static description = commandHelp.description;
	static flags = {
		push: Flags.boolean({ description: "Push after committing" }),
		"dry-run": Flags.boolean({ description: "Preview without committing" }),
		"no-changelog": Flags.boolean({ description: "Skip changelog updates" }),
		context: Flags.string({ char: "c", description: "Additional context for the model" }),
		model: Flags.string({ char: "m", description: "Override model selection" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Commit);

		const cmd: CommitCommandArgs = {
			push: flags.push ?? false,
			dryRun: flags["dry-run"] ?? false,
			noChangelog: flags["no-changelog"] ?? false,
			context: flags.context,
			model: flags.model,
		};

		await initTheme();
		// Bun's fetch keeps idle provider connections warm and Settings/OAuth
		// timers stay armed after the commit is written; exit explicitly so the
		// CLI returns to the shell (issue #1041).
		let exitCode = 0;
		try {
			await runCommitCommand(cmd);
		} catch (error) {
			if (!(error instanceof CommitAbortedError)) throw error;
			// Failure already reported with a readable message; exit non-zero
			// without letting the runtime dump a stack/minified-source blob.
			exitCode = 1;
		}
		await postmortem.quit(exitCode);
	}
}

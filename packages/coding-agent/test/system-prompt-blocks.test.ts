import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

const USER_POLICY = "USER-POLICY: answer in Polish.";
const userPolicyPath = () => path.join(os.homedir(), ".agents", "AGENTS.md");

function writeUserPolicy(): void {
	fs.mkdirSync(path.dirname(userPolicyPath()), { recursive: true });
	fs.writeFileSync(userPolicyPath(), USER_POLICY);
}

async function render(cwd: string, systemPrompt?: string): Promise<string[]> {
	const result = await buildSystemPrompt({ cwd, systemPrompt, skills: [], rules: [], toolNames: ["read", "bash"] });
	return result.systemPrompt;
}

describe("system prompt blocks", () => {
	const tempDir = TempDir.createSync("@omp-system-prompt-blocks-");
	const cwd = tempDir.join("project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT-RULE: run bun check.");
	afterAll(() => tempDir.removeSync());
	afterEach(() => fs.rmSync(userPolicyPath(), { force: true }));

	it("renders harness, the user policy file, then project context", async () => {
		writeUserPolicy();

		const [harness, policy, context, ...rest] = await render(cwd);

		expect(rest).toEqual([]);
		expect(harness).toContain("# Internal URLs");
		expect(policy).toBe(USER_POLICY);
		expect(context).toContain("PROJECT-RULE: run bun check.");
		expect([harness, context].join("\n")).not.toContain(USER_POLICY);
	});

	it("lets an explicit system prompt replace only the policy block", async () => {
		writeUserPolicy();
		const [mainHarness, , mainContext] = await render(cwd);

		const blocks = await render(cwd, "You are a scout.");

		expect(blocks).toEqual([mainHarness, "You are a scout.", mainContext]);
	});

	it("omits the policy block when no policy source exists", async () => {
		const blocks = await render(cwd);

		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("# Internal URLs");
		expect(blocks[1]).toContain("PROJECT-RULE: run bun check.");
	});
});

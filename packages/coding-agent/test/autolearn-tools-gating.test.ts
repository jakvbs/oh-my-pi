import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, type Skill, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ManageSkillTool } from "@oh-my-pi/pi-coding-agent/tools/manage-skill";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

function makeSession(settingsOverrides: Record<string, unknown> = {}, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(settingsOverrides),
		...extra,
	};
}

describe("autolearn tool gating", () => {
	it("does not offer manage_skill by default (autolearn disabled)", async () => {
		const names = (await createTools(makeSession())).map(t => t.name);
		expect(names).not.toContain("manage_skill");
	});

	it("offers manage_skill, marked essential, when enabled", async () => {
		const tools = await createTools(makeSession({ "autolearn.enabled": true }));
		const manage = tools.find(t => t.name === "manage_skill");
		expect(manage).toBeDefined();
		// loadMode "essential" is what keeps it active under tools.discoveryMode "all".
		expect(manage?.loadMode).toBe("essential");
	});

	it("force-includes manage_skill into an explicit restricted toolNames list", async () => {
		// A session created with autolearn on but a narrow tool list still gets the
		// controller/guidance, so the tool the nudge points at must be present.
		const names = (await createTools(makeSession({ "autolearn.enabled": true }), ["read"])).map(t => t.name);
		expect(names).toContain("manage_skill");
	});

	it("excludes manage_skill from a subagent when not in the explicit list", async () => {
		// The controller never runs here, so a subagent's explicit
		// whitelist must not be silently widened with write-capable tools.
		const sub = (await createTools(makeSession({ "autolearn.enabled": true }, { isSubagent: true }), ["read"])).map(
			t => t.name,
		);
		expect(sub).not.toContain("manage_skill");

		// Nor via discovery (no explicit list) at depth.
		const subDiscovered = (await createTools(makeSession({ "autolearn.enabled": true }, { isSubagent: true }))).map(
			t => t.name,
		);
		expect(subDiscovered).not.toContain("manage_skill");
	});

	it("allows manage_skill in a subagent when explicitly requested in toolNames", async () => {
		const sub = (
			await createTools(makeSession({ "autolearn.enabled": true }, { isSubagent: true }), ["manage_skill"])
		).map(t => t.name);
		expect(sub).toContain("manage_skill");
	});
});

describe("manage_skill execute", () => {
	let tempHome: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manage-skill-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		resetActiveSkillsForTests();
		await removeWithRetries(tempHome);
	});

	const tool = () => ManageSkillTool.createIf(makeSession({ "autolearn.enabled": true }))!;

	it("create writes the managed SKILL.md; delete removes it", async () => {
		const file = path.join(getManagedSkillsDir(), "demo", "SKILL.md");
		await tool().execute("1", { action: "create", name: "demo", description: "When to demo.", body: "# Demo" });
		expect(await Bun.file(file).exists()).toBe(true);

		await tool().execute("2", { action: "delete", name: "demo" });
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("rejects create without a body and delete of a missing skill", async () => {
		await expect(tool().execute("3", { action: "create", name: "nobody", description: "d" })).rejects.toThrow(
			/requires/,
		);
		await expect(tool().execute("4", { action: "delete", name: "absent" })).rejects.toThrow(/does not exist/);
	});

	it("schema rejects create/update without description+body but allows delete", () => {
		const schema = tool().parameters;
		expect(schema({ action: "create", name: "x" }) instanceof type.errors).toBe(true);
		expect(schema({ action: "update", name: "x", description: "d" }) instanceof type.errors).toBe(true);
		expect(schema({ action: "create", name: "x", description: "d", body: "b" }) instanceof type.errors).toBe(false);
		expect(schema({ action: "delete", name: "x" }) instanceof type.errors).toBe(false);
	});

	it("refuses to create a managed skill an authored skill of the same name would shadow", async () => {
		const authored: Skill = {
			name: "demo",
			description: "An authored demo skill.",
			filePath: path.join(tempHome, "authored", "demo", "SKILL.md"),
			baseDir: path.join(tempHome, "authored", "demo"),
			source: "native:user",
			_source: {
				provider: "native",
				providerName: "Pi",
				path: path.join(tempHome, "authored", "demo", "SKILL.md"),
				level: "user",
			},
		};
		setActiveSkills([authored]);

		const result = await tool().execute("c", {
			action: "create",
			name: "demo",
			description: "When to demo.",
			body: "# Demo",
		});

		// Reported as an error, not a false "Created".
		expect(result.isError).toBe(true);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toMatch(/authored skill/i);
		expect(text).not.toContain("Created");
		// Nothing was written, so the managed skill can never surface.
		expect(await Bun.file(path.join(getManagedSkillsDir(), "demo", "SKILL.md")).exists()).toBe(false);
	});
});

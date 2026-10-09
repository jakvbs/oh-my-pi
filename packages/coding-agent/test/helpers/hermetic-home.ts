import { afterAll, beforeEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Tests must not read the operator's ~/.omp (SYSTEM.md, config.yml, agents),
// ~/.agents or ~/.claude: a local run then diverges from CI, whose HOME is empty.
// Each test process gets a fresh, empty home before any test module loads.
// Bun resolves os.homedir() from the startup environment, so the function is
// spied; the env vars cover child processes. Tests that restore all mocks also
// restore this spy, so it is re-applied before every test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
]) {
	delete process.env[name];
}

function isolateHomedir(): void {
	if (os.homedir() !== home) spyOn(os, "homedir").mockImplementation(() => home);
}

isolateHomedir();
beforeEach(isolateHomedir);
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

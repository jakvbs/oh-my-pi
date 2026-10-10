import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FnoxRequest, parseFnoxRequests, registerFnoxSecrets } from "../src/secrets/fnox";
import { SecretObfuscator } from "../src/secrets/obfuscator";

const STAGING_URL = "postgres://app:StagingPass_9f2k@staging-db.example:5432/rehabico";
const CF_TOKEN = "cf_fake_rehabico_token_AAAA1111";

function stubResolver(byProfiles: Record<string, Record<string, string>>) {
	const calls: FnoxRequest[] = [];
	const resolve = async (request: FnoxRequest) => {
		calls.push(request);
		return byProfiles[request.profiles.join(",")];
	};
	return { calls, resolve };
}

async function tempDir(withConfig: boolean): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fnox-"));
	if (withConfig) await fs.writeFile(path.join(dir, "fnox.toml"), "[secrets]\n");
	return dir;
}

describe("parseFnoxRequests", () => {
	it("reads profiles and config from fnox invocations that resolve secrets", () => {
		expect(parseFnoxRequests("fnox -P staging exec -- printenv DATABASE_URL")).toEqual([{ profiles: ["staging"] }]);
		expect(parseFnoxRequests("FNOX_PROFILE=prod fnox exec -- bun run migrate")).toEqual([{ profiles: ["prod"] }]);
		expect(parseFnoxRequests("fnox exec -P staging -- bun run migrate")).toEqual([{ profiles: ["staging"] }]);
		expect(parseFnoxRequests("fnox -Pqa get DATABASE_URL")).toEqual([{ profiles: ["qa"] }]);
		expect(
			parseFnoxRequests(
				'cd apps/web && fnox --config "$HOME/.config/fnox/config.toml" --profile=ai,ccv --no-defaults exec -- omp',
			),
		).toEqual([{ profiles: ["ai", "ccv"], config: "$HOME/.config/fnox/config.toml" }]);
		expect(parseFnoxRequests("fnox exec -- env", "staging")).toEqual([{ profiles: ["staging"] }]);
		expect(parseFnoxRequests("ls && fnox x -- env | grep KEY")).toEqual([{ profiles: ["default"] }]);
	});

	it("ignores fnox commands that resolve nothing and quoted mentions", () => {
		expect(parseFnoxRequests("fnox set DATABASE_URL --provider age")).toEqual([]);
		expect(parseFnoxRequests("fnox profiles")).toEqual([]);
		expect(parseFnoxRequests('echo "fnox -P prod exec -- env"')).toEqual([]);
		expect(parseFnoxRequests("git status")).toEqual([]);
	});
});

describe("registerFnoxSecrets", () => {
	it("hides values a fnox profile injects into a command and restores them for tools", async () => {
		const obfuscator = new SecretObfuscator([], crypto.randomBytes(32).toString("base64url"));
		const cwd = await tempDir(false);
		const { resolve } = stubResolver({ staging: { DATABASE_URL: STAGING_URL, CLOUDFLARE_API_TOKEN: CF_TOKEN } });

		await registerFnoxSecrets({
			obfuscator,
			command: "fnox -P staging exec -- sh -c 'echo $DATABASE_URL $CLOUDFLARE_API_TOKEN'",
			cwd,
			resolve,
		});

		const output = `DB=${STAGING_URL}\nCF=${CF_TOKEN}\npassword alone: StagingPass_9f2k`;
		const visible = obfuscator.obfuscate(output);
		expect(visible).not.toContain("StagingPass_9f2k");
		expect(visible).not.toContain(CF_TOKEN);
		expect(visible).toContain("STAGINGDATABASEURL");
		expect(obfuscator.deobfuscate(visible)).toBe(output);
	});

	it("registers the default profile of a directory with a fnox config without an explicit fnox call", async () => {
		const obfuscator = new SecretObfuscator([], crypto.randomBytes(32).toString("base64url"));
		const withConfig = await tempDir(true);
		const withoutConfig = await tempDir(false);
		const { calls, resolve } = stubResolver({ default: { DATABASE_URL: STAGING_URL } });

		await registerFnoxSecrets({ obfuscator, command: "bun run migrate", cwd: withoutConfig, resolve });
		expect(calls).toEqual([]);

		await registerFnoxSecrets({ obfuscator, command: "bun run migrate", cwd: withConfig, resolve });
		expect(calls).toEqual([{ profiles: ["default"] }]);
		expect(obfuscator.obfuscate(STAGING_URL)).not.toContain("StagingPass_9f2k");
	});

	it("resolves each profile set once per session, including concurrent commands", async () => {
		const obfuscator = new SecretObfuscator([], crypto.randomBytes(32).toString("base64url"));
		const cwd = await tempDir(false);
		const { calls, resolve } = stubResolver({ staging: { DATABASE_URL: STAGING_URL } });
		const command = "fnox -P staging exec -- bun run migrate";

		await Promise.all([
			registerFnoxSecrets({ obfuscator, command, cwd, resolve }),
			registerFnoxSecrets({ obfuscator, command, cwd, resolve }),
		]);
		await registerFnoxSecrets({ obfuscator, command, cwd, resolve });

		expect(calls).toEqual([{ profiles: ["staging"] }]);
	});

	it("keeps going when a profile cannot be resolved non-interactively", async () => {
		const obfuscator = new SecretObfuscator([], crypto.randomBytes(32).toString("base64url"));
		const cwd = await tempDir(false);
		const resolve = async () => {
			throw new Error("hardware key required");
		};

		await registerFnoxSecrets({ obfuscator, command: "fnox -P prod exec -- env", cwd, resolve });

		expect(obfuscator.hasSecrets()).toBe(false);
	});
});

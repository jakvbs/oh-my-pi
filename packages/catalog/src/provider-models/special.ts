import { logger, once } from "@oh-my-pi/pi-utils";
import { providerEntry, seedModels } from "../compat/providers";
import { type CodexModelDiscoveryResult, fetchCodexModels } from "../discovery/codex";
import { fetchTypeSafeModels, TYPESAFE_DEFAULT_BASE_URL } from "../discovery/typesafe";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { unionAccountCatalogs } from "./account-access";
import { resolveModelCacheProviderId } from "./cache-provider-id";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

/** One Codex OAuth account to fetch a catalog for. */
export interface OpenAICodexAccount {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id sent as the `chatgpt-account-id` header. */
	accountId?: string;
}

export interface OpenAICodexModelManagerConfig {
	/**
	 * Resolves every configured Codex OAuth account at discovery time. Codex
	 * discovery is account-scoped — a model can be available to one account and
	 * absent from another — so each account's `/models` endpoint is fetched
	 * independently and the results unioned by id. Without this, discovery would
	 * surface only the account it happened to resolve and, being authoritative,
	 * prune every model the other accounts expose (#6265).
	 *
	 * Returns `null` to abort discovery entirely (e.g. an account's credential
	 * failed to refresh): a partial account set would be cached as the complete
	 * authoritative catalog and hide the missing account's models, so the caller
	 * keeps the previous/bundled catalog instead.
	 */
	resolveAccounts?: () => Promise<readonly OpenAICodexAccount[] | null>;
	/**
	 * Codex backend base URL (e.g. a Codex-compatible gateway from `models.yml`).
	 * Defaults to the official ChatGPT backend. Also scopes the discovery cache,
	 * so a gateway roster never serves the official endpoint and vice versa.
	 */
	baseUrl?: string;
	clientVersion?: string;
	fetch?: FetchImpl;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { resolveAccounts, baseUrl, clientVersion, fetch } = config;
	return {
		providerId: "openai-codex",
		cacheProviderId: resolveModelCacheProviderId("openai-codex", { baseUrl }),
		dynamicModelsAuthoritative: providerEntry("openai-codex")?.dynamicModelsAuthoritative === true,
		...(resolveAccounts
			? {
					fetchDynamicModels: async () => {
						const accounts = await resolveAccounts();
						if (!accounts || accounts.length === 0) return null;
						const results = await Promise.all(
							accounts.map(async account => ({
								accountId: account.accountId,
								result: await fetchCodexModels({
									accessToken: account.accessToken,
									accountId: account.accountId,
									baseUrl,
									clientVersion,
									fetchFn: fetch,
								}),
							})),
						);
						return unionCodexModels(results);
					},
				}
			: undefined),
	};
}

/**
 * Merge complete per-account Codex catalogs into one authoritative list via
 * {@link unionAccountCatalogs}.
 *
 * Returns `null` when any account's fetch failed transiently, so a partial list
 * cannot replace the previous or bundled authoritative catalog. An account
 * whose credential the backend rejected outright (401/403 — revoked or
 * deauthorized) contributes nothing and is skipped instead: it would otherwise
 * veto every sibling account's models until the user removes it. If no account
 * produced a catalog, discovery aborts the same way.
 */
function unionCodexModels(
	results: readonly { accountId: string | undefined; result: CodexModelDiscoveryResult | null }[],
): ModelSpec<"openai-codex-responses">[] | null {
	const catalogs: ModelSpec<"openai-codex-responses">[][] = [];
	for (const { accountId, result } of results) {
		if (!result) return null;
		if (result.rejectedStatus !== undefined) {
			logger.warn("Codex model discovery skipped an account whose credential was rejected", {
				accountId,
				status: result.rejectedStatus,
			});
			continue;
		}
		catalogs.push(result.models);
	}
	return catalogs.length > 0 ? unionAccountCatalogs(catalogs) : null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		dynamicModelsAuthoritative: true,
		cacheProviderId: resolveModelCacheProviderId("cursor", { apiKey, baseUrl }),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// Synthetic role providers
// ---------------------------------------------------------------------------

export function localModelManagerOptions(): ModelManagerOptions<"local-inference"> {
	return {
		providerId: "local",
		cacheProviderId: resolveModelCacheProviderId("local"),
		staticModels: seedModels<"local-inference">("local"),
	};
}

export function webModelManagerOptions(): ModelManagerOptions<"web-search"> {
	return {
		providerId: "web",
		cacheProviderId: resolveModelCacheProviderId("web"),
		staticModels: seedModels<"web-search">("web"),
	};
}

/** Cloudflare Workers AI judges: the authored Clef rows; the account id resolves per request. */
export function cloudflareWorkersAiModelManagerOptions(): ModelManagerOptions<"workers-ai-systemone"> {
	return {
		providerId: "cloudflare-workers-ai",
		cacheProviderId: resolveModelCacheProviderId("cloudflare-workers-ai"),
		staticModels: seedModels<"workers-ai-systemone">("cloudflare-workers-ai"),
	};
}

/** Credentials and endpoint overrides for the TypeSafe catalog manager. */
export interface TypeSafeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/** Discover account-visible judge models while keeping the bundled offline seed. */
export function typesafeModelManagerOptions(config: TypeSafeModelManagerConfig = {}): ModelManagerOptions<"typesafe"> {
	const { apiKey } = config;
	const envBaseUrl = Bun.env.TYPESAFE_BASE_URL?.trim();
	const baseUrl = (config.baseUrl ?? (envBaseUrl || TYPESAFE_DEFAULT_BASE_URL)).replace(/\/+$/, "");
	const staticModels = seedModels<"typesafe">("typesafe");
	return {
		providerId: "typesafe",
		cacheProviderId: resolveModelCacheProviderId("typesafe"),
		staticModels: staticModels.map(model => ({ ...model, baseUrl })),
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: () =>
						fetchTypeSafeModels({
							apiKey,
							baseUrl,
							fetch: config.fetch,
						}),
				}
			: undefined),
	};
}
// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

/** Creates model-manager options for Z.AI's mixed native and Anthropic transports. */
export function zaiModelManagerOptions(
	_config: ZaiModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages" | "openai-completions"> {
	return { providerId: "zai" };
}

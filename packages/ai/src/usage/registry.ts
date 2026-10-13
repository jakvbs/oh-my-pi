import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { charmHyperUsageProvider } from "./charm-hyper";
import { claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { commandCodeRankingStrategy, commandCodeUsageProvider } from "./commandcode";
import { githubCopilotUsageProvider } from "./github-copilot";
import { kimiRankingStrategy, kimiUsageProvider } from "./kimi";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./opencode-go";
import { syntheticUsageProvider } from "./synthetic";
import { umansUsageProvider } from "./umans";
import { xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider } from "./zai";

/** Resolves the usage-based ranking strategy for a provider. */
export type RankingStrategyResolver = (provider: Provider) => CredentialRankingStrategy | undefined;

/** Built-in usage providers, in probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	openaiCodexUsageProvider,
	kimiUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
	charmHyperUsageProvider,
	commandCodeUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

/** Built-in usage provider for `provider`. */
export function defaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
	["xai-oauth", xaiOauthRankingStrategy],
	["commandcode", commandCodeRankingStrategy],
]);

/** Built-in ranking strategy for `provider`. */
export function defaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

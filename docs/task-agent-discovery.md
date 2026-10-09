# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Agents are TypeScript modules only: `~/.omp/agent/agents/*.ts` (user), `.omp/agents/*.ts` (project), and `<extension-root>/agents/*.ts`. Markdown files in those directories are ignored. The module's default export is an `AgentSpec` (`src/task/types.ts`):

- required `name`, `description`, and `systemPrompt`
- optional `tools`, `model` (one selector or a prioritized list), `thinkingLevel`, `cwd`, `skills`, `mcp`
- unknown keys reject the module, so a misspelled `mcp`/`skills` cannot silently widen the agent

`parseAgentModule()` (`src/task/agents.ts`) validates the export and normalizes it into `AgentDefinition`:

- `main` and `sub` are reserved names (checked after trimming and lowercasing); definitions using them are rejected
- `tools` legacy aliases are normalized and `yield` is auto-added; an explicit `tools: []` therefore grants `yield`, not the default toolset
- `model` entries are tried in order after role aliases are expanded
- `thinkingLevel` selects the agent's configured effort. When `task.enableEffort` (default `false`) exposes it, a task item's coarse `effort` (`lo`, `med`, `hi`) takes precedence at launch. OMP maps that hint to the selected model's lowest, middle, or highest supported effort, then clamps it to `task.maxEffort` (default `max`).
- `cwd` resolves against the spawning session's cwd (the isolation worktree for isolated runs, where a path leaving it fails the spawn)
- `skills` filters the inherited skills; `mcp` names the only MCP servers whose proxy tools the subagent gets (absent = no MCP), e.g. a `jira-agent` with `mcp: ["jira"]`
- `source` is `"user" | "project"` (extension agents are tagged with their extension root's level)

## Role-backed custom agents

Give the agent a role alias, then dispatch it by name. For model routing, task dispatch sets only `agent`; it does not set a worker model:

`~/.omp/agent/agents/reviewer.ts`:

```ts
export default {
	name: "reviewer",
	description: "Review a change for correctness.",
	model: "@review",
	systemPrompt: "Review the assigned change and report concrete findings.",
};
```

Set the role mapping in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` resolves through `modelRoles.review`. Each `modelRoles.<role>` value stores a concrete model selector and may append a thinking suffix such as `:high` (`src/config/model-resolver.ts`). Changing that mapping affects subsequent task resolutions without editing agent definitions. Task preflight reloads the current global, project, and explicit overlay settings before rediscovering agents, so agent modules and their role aliases added during a live session resolve from one refreshed configuration state. Discovery re-imports a module whose mtime changed.

With the default batched task schema, supply shared `context` and per-item `task` and `solutionSpace`. `solutionSpace` describes how open-ended the assignment is, rather than its size. Every item names its `agent`; an omitted `agent` fails with the list of available agents:

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    {
      "agent": "reviewer",
      "task": "Report concrete correctness findings.",
      "solutionSpace": "Review cause and failure modes are open; no known defect."
    }
  ]
}
```

`/model`'s Roles view can assign and persist custom role mappings such as `review`, `fast`, and `good`. Changing only the active or default session selection does not remap those roles.

## User-tagged model agents

Type `^` in the composer to choose a model from the same scope and ranking as the `Alt+P` session picker. Accepting a completion inserts an atomic chip showing its display name. For example, type `Have ^`, pick a model, then finish with `review this change`.

On submit, each first-mentioned model receives a branch-local pseudonym (`m1`, `m2`, …). The user message carries `<model agent="m1" name="Display Name"/>`; the task description lists its provider/model selector. `task` accepts that pseudonym as its `agent`. These agents run with no agent-specific system prompt and are intended only for requests explicitly naming the tagged model.

Tagging a model never rewrites the model-facing `task` description mid-session: the description lists the pseudonyms baked into the current base prompt, and later tags arrive as a hidden `session-agents` system notice on the next user turn. The notice rides the same channel as the tool-roster deltas, so the provider cache prefix stays byte-stable. The next base-prompt rebuild absorbs the live set into the description.

Pseudonyms survive `/resume`; rewinding before a model's first mention frees its number. Repeating a selector reuses its pseudonym. Unknown selectors remain literal, as do mentions in `!`/`$` local-execution drafts. Tokens require whitespace boundaries: autocomplete adds the trailing space. When two models share a display name in one draft, the second remains a literal selector to avoid ambiguous expansion.

Session definitions are appended after discovered agents, so an existing agent with the same name wins. Normal spawn restrictions and model-override precedence still apply. Synthetic prompts cannot register models.

## Watch running agents

After dispatch, press `Alt+A` to open [Agent Hub](./agent-hub.md). Its live roster shows each task agent's status, current activity, model, age, and usage. Select an agent to read its transcript and steer it directly; parked agents can be revived from the same view. Enable `tui.mouse` to click live task cards and jump-list rows instead, or watch the pinned `Subagents` block above the editor.

## Filesystem discovery

`discoverAgents(cwd, home, extensionRoots?)` (`src/task/discovery.ts`) merges agents from OMP-native roots and OMP extension packages. OMP ships no built-in agents: with none discovered, the `task` tool has nothing to spawn. Claude Code plugin agents and cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are not agent sources (`TASK_AGENT_CONFIG_SOURCE = ".omp"` filters the native config-dir lists).

### Discovery inputs and precedence

1. Nearest project `.omp/agents` dir from `findAllNearestProjectConfigDirs("agents", cwd)` (first `.omp` hit only)
2. User `.omp/agents` dir from `getConfigDirs("agents", { project: false })` (first `.omp` hit only)
3. `<extension-root>/agents` for every enabled OMP extension package returned by `listOmpExtensionRoots(...)`, in this order:
   - explicit CLI `--extension` / SDK `additionalExtensionPaths` directory roots
   - the session's effective `extensions:` array, in its configured order
   - installed npm/link plugins
   Project and user `extensions:` arrays are not concatenated: settings use array-replacement precedence. In `explicit-only` mode (`--no-extensions` or SDK `disableExtensionDiscovery`), only explicit roots contribute this package surface; file entrypoints have no `agents/` subdirectory to scan.

The extension-package surface is disabled when the `omp-plugins` capability provider is disabled.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`, in directory order:

- Project `.omp` overrides user `.omp`.
- Earlier extension roots override later extension roots.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, `.ts` files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty
- an import failure or an export that fails `parseAgentModule` logs a warning and skips the file

Net effect: one bad agent module does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- every launch requires an explicit `agent`; missing names fail preflight with the available agents

`resolveEffectiveSubagentPolicy()` resolves every task subagent launch. Before allocating artifacts it:

1. atomically reloads the live session's persisted global, project, and explicit overlay settings while preserving runtime overrides
2. trims the explicit agent name
3. enforces the root-only spawning boundary and blocked-self-recursion guard
4. rediscovers agents with the session's cwd and effective extension-root configuration, appends user-tagged session agents, and performs exact lookup
5. checks `task.disabledAgents`
6. resolves plan-mode restrictions, output schema, model policy, and isolation policy

A missing name fails preflight with `Unknown agent "...". Available: ...`; no subprocess runs.

### Description vs execution-time discovery

`TaskTool.create()` memoizes discovery by resolved working directory plus the complete effective extension-root configuration when building the model-facing tool description. Each description read also includes the user-tagged model agents frozen into the current base prompt surface (see [user-tagged model agents](#user-tagged-model-agents)) rather than the live set, so tagging a model mid-session cannot mutate the provider tool prefix. Execution rediscovers agents and merges the live session agents, so the runtime set can differ from the earlier description if agent or extension files changed mid-session. Blocking behavior is determined after policy resolution rather than from a stale description-time agent object.

## Model and structured-output precedence

For task dispatch, model precedence is:

1. `task.agentModelOverrides[agentName]`
2. the agent's prioritized `model` list
3. the parent's active model, then its configured/default model fallback

Role aliases in either of the first two sources are expanded through `modelRoles`.

After policy resolution, the `before_subagent_spawn` extension hook runs once for the actual dispatch. It can block the spawn or replace the resolved model patterns; a routing note is carried into progress metadata.

The `Alt+P` task model pick is session-only; saving a model in `/agents` replaces that runtime selection for the current session and persists the new value for future sessions.

Compaction triggers are separate from model and service-tier selection: an exact, case-sensitive
`task.agentCompactionThresholdOverrides[agentName]` entry (`90000` or `"80%"`) replaces the
`compaction.threshold*` settings for that agent only; agents without an entry, including agents it
spawns, use the main session's thresholds. See [Settings](./settings.md#context-compaction-and-memory).

Service-tier precedence is independent of model selection: an exact, case-sensitive
`task.agentServiceTierOverrides[agentName]` entry overrides `tier.subagent`; an absent entry preserves
the global behavior. `inherit` snapshots the parent session's live per-family tiers (including
`/fast` changes) for the next spawn. The child session resolves a concrete value against the model
it finally settles on — after auth fallback and after patterns only the session can resolve, such as
extension-registered models — and populates only that model's provider family when the family
supports the value, so same-family retry fallbacks retain the tier and cross-family fallbacks never
inherit it. The resolved map is persisted with the child's session, even when it is empty, so a
parked agent revived after a restart keeps its per-agent tier instead of re-deriving
`tier.subagent`. The entry is looked up by task dispatch only. Service tiers are configuration-only; agent modules and
the task wire format does not expose a tier field or automatic Fast policy.

Account selection is independent of model and service-tier selection: an exact, case-sensitive
`task.agentAccountPools[agentName]` entry maps provider ids to OAuth identity keys (the `identityKey`
values broker [client account pools](./auth-broker-gateway.md#client-account-pools-routing-not-authorization)
use, such as `email:<address>|org:<id>` for Anthropic; [`omp usage accounts`](./cli-reference.md)
lists them). For each listed provider the child authenticates
only with those accounts: ranking, the parent's copied account affinity, restored pins, fallback
passes, and credential rotation stay inside the pool, and runtime, environment, and stored API keys
are not used; a `models.yml` `apiKey` for the provider fails the request instead of sending a pooled
token to that endpoint. When no pooled account can serve, the request fails with `No API key for
provider: … restricted to its OAuth account pool` instead of borrowing another account; an empty
list allows no account. Pools do not pick models, so model and retry-fallback policy still decide
which provider the child calls. The pool covers every key lookup the agent makes, whatever provider
session id it carries: fresh or reset sessions, advisors, title generation, skill compression, and
subagents it spawns without their own entry (an entry of their own replaces it). A parked agent revived in the same process or after a restart
takes the live entry for its agent name. A custom SDK `getApiKey` resolver bypasses pools.

Runtime output schema precedence is:

1. the task item's explicit `outputSchema`
2. parent session `outputSchema`

The task item's optional `schemaMode` overrides the parent session mode; the default is `permissive`.

Explicit caller schemas are validated during preflight in both modes. Session schemas are preflight-validated when the effective mode is `strict`. Invalid schemas fail before child execution.

The model-facing prompt (`src/prompts/tools/task.md`) tags read-only agents.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`resolveEffectiveSubagentPolicy()` checks `task.disabledAgents` after resolving the agent. A disabled name fails preflight and lists enabled alternatives when available.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` (or the internal request override) rejects an attempt to spawn the same blocked agent before discovery.

### One subagent level

Only the root session (`isSubagent: false`) holds `task`; the shared policy rejects a spawn from any subagent, and `runSubprocess` removes `task` from every child tool list. Persisted legacy `spawns` metadata is ignored. Cold revival always marks the session as a subagent, including historical nested transcripts.

For an explicit agent tool list, the legacy `exec` entry expands to `bash`. A list containing `task` or `bash` also gains `wait` unless the parent requires an exact restricted tool list; tool construction still omits `wait` when there is no async, IRC, or service wake source. Outbound peer messaging requires `write` in the child tool list and IRC enabled; inbound steering does not.

## Plan mode behavior

When parent plan mode is enabled, `resolveEffectiveSubagentPolicy()` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `grep`, `glob`, and `web_search`, plus `ast_grep` when the agent's own tool list declares it
- clears `prewalk` (read-only exploration must not receive the prewalk plan/implement nudges)

Plan mode also rejects per-spawn isolation, apply, and merge controls. The same `effectiveAgent` is used for subprocess launch, model/thinking overrides, and output-schema selection.

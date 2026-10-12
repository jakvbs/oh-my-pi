# System Prompt Customization

How the coding agent assembles its system prompt and what users control. Every session's prompt has one model: a harness block owned by OMP, one optional policy block owned by the user, and a context block generated from the working directory.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `BuildSystemPromptOptions`, user policy loading)
- `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions`, prompt construction)
- `packages/coding-agent/src/main.ts` (`--system-prompt` resolution)
- `packages/coding-agent/src/prompts/system/harness-prompt.md` (harness block)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (context block)
- `packages/coding-agent/src/prompts/system/date-cwd-reminder.md` (per-request date, cwd, and session ID reminder)

## Block layout

The provider-facing prompt is an ordered block array, most stable first:

| Block   | Owner | Source                                                                                     | Content                                                                                                                                                                                       |
| ------- | ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness | OMP   | `harness-prompt.md`                                                                        | Runtime mechanics only. RFC 2119 and XML-tag conventions, output rendering, the skills and rules index, internal URLs, the tool inventory, `xd://` devices, scratchpad, tool I/O, delegation. |
| Policy  | User  | `--system-prompt`, SDK `systemPrompt`, or `~/.agents/AGENTS.md`                           | How the agent should work. Omitted when no source is set or the text is empty.                                                                                                                |
| Context | OMP   | `project-prompt.md`                                                                        | `<project-context>` with workstation data, project context files, always-apply rules, directory-context pointers, workspace tree and roots, active nested-repository context, then generated notices. |

The harness carries no role, personality, workflow, or tool-preference policy. Those belong in the policy block, so the user writes them once and every session reads them from one file.

Generated notices close the context block. They are auto-learn guidance, the `xd://` map of MCP tools, and MCP server instructions (`## MCP Server Instructions`, declared server-controlled and unverified), each present only when enabled.

On Anthropic, the system cache breakpoint lands on the last block before the first `<project-context>` block. Sessions in different directories therefore share the harness and policy as a cached prefix. Other providers receive the same ordered blocks.

The working directory, calendar date, and session ID are not in the system prompt. They ride a `<system-reminder>` on the first user turn, which keeps volatile bytes out of the cached prefix. Git state is not rendered at all. The agent asks `git` when it needs it.

## Policy sources

The policy block comes from exactly one source, first match wins:

1. `--system-prompt <text-or-file>` on the CLI.
2. `CreateAgentSessionOptions.systemPrompt` in the SDK, a string or a `() => string` evaluated on every prompt rebuild.
3. `~/.agents/AGENTS.md`, read on every rebuild with `@path` includes expanded.

The path is fixed. Profiles, `PI_CODING_AGENT_DIR`, and the SDK `agentDir` option do not change it, and `~/.omp/agent/AGENTS.md` is not read. Editing the file and running `/new` or `/clear` picks up the change without a restart.

`~/.agents/AGENTS.md` is the policy, not a context file. It is never rendered inside `<repo-rules>`.

### Text or file resolution

For a single-line `--system-prompt` value, OMP first tries to read that value as a file path. If the path does not exist (or is too long to be a path), the value is used literally. A value containing a newline is used literally without a file read. Other read failures are logged and the value is used literally.

The policy text is plain text. It is inserted verbatim and never compiled as Handlebars, so `{{cwd}}` reaches the model as those characters.

## Inputs by session type

Which automatic inputs reach each kind of session. An input applies only when it exists or is enabled. Advisors build a dedicated prompt that also carries memory instructions and the shared and per-advisor instructions; `@path` imports in `WATCHDOG.md` are expanded.

| Session type     | Policy block                                       | Project `AGENTS.md` | Project `CLAUDE.md` / `GEMINI.md` | MCP tools | MCP server instructions | `WATCHDOG.md` |
| ---------------- | -------------------------------------------------- | ------------------- | --------------------------------- | --------- | ----------------------- | ------------- |
| Main session     | `--system-prompt` or `~/.agents/AGENTS.md`        | Discovered          | Discovered                        | Yes       | Yes                     | No            |
| Task subagent    | The agent definition rendered for this spawn       | Not inherited       | Inherited                         | Inherited | Inherited               | No            |
| Advisor/watchdog | Dedicated advisor prompt                           | Inherited           | Inherited                         | No        | No                      | Yes           |

1. A task subagent keeps the harness and the context block. Its policy is the subagent prompt rendered from the agent definition and assignment, so the main agent's user policy does not leak into it.
2. Task spawning drops inherited context files whose basename is `agents.md` (case-insensitive). Text pulled in through `@` imports is not filtered, and additional workspace roots are discovered separately.
3. Context discovery reads project-level files only. User-level files such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and `~/.copilot/copilot-instructions.md` are not loaded. Put user-wide instructions in `~/.agents/AGENTS.md`.
4. A task agent's `tools:` list does not remove MCP tools or server instructions: the tools stay available top-level or under `xd://`. Children of restricted sessions run with `restrictToolNames`, which drops both.

## Recipes

### Set user-wide instructions

```text
~/.agents/AGENTS.md
Prefer small diffs. Run the narrowest relevant test before handing off.
```

### Use a different policy for one run

```bash
omp --system-prompt ./reviewer-policy.md
```

The harness and context blocks still render, so the run keeps tool mechanics and project context.

### Customize automatic session titles

The policy block does not affect title-generation calls. Use `TITLE_SYSTEM.md`:

```text
~/.omp/agent/TITLE_SYSTEM.md
Return a concise noun phrase that names the user's task.
```

`TITLE_SYSTEM.md` uses project-first config-base discovery with no ancestor walk. Foreign user bases require `enabledProviders` opt-in (or `CLAUDE_CONFIG_DIR` for Claude). When absent, OMP titles a new session from a fork of its first reply (the session's own model, on the cached prompt) with the bundled tiny-model title prompt as the fallback. The override is used for both initial automatic titles and replan-driven title refreshes, and turns the reply fork off: titles come from the tiny title model.

Generated title output has an enforced normalization contract even with a custom prompt. OMP considers only the first trimmed line, strips surrounding quotes, `<title>...</title>` markers, and terminal punctuation, and treats `none` or `<title/>` as “no title yet.” A result longer than 80 characters or 12 words is rejected rather than truncated. Empty, deferred, or rejected output leaves the session unnamed, so a later eligible title attempt can name it.

## Programmatic API options

| Option                                     | Effect                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateAgentSessionOptions.systemPrompt`   | The policy block. A string, or a function re-evaluated on every rebuild. Replaces `~/.agents/AGENTS.md`. Harness and context still render. |
| `CreateAgentSessionOptions.fixedSystemPrompt` | A `readonly string[]` sent verbatim as every system block. No harness, policy, or context is generated. Use it for helper sessions with their own complete contract and for replaying a persisted prompt. |
| `buildSystemPrompt({ systemPrompt })` | Renders the same three blocks outside a session. `systemPrompt` is the policy text; `~/.agents/AGENTS.md` is read when it is absent. |

## Removed sources

These sources no longer exist. Move their content into `~/.agents/AGENTS.md`.

| Removed                                                     | Replacement                                    |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `SYSTEM.md`, `SYSTEM_TEMPLATE.md` (every config base)       | `~/.agents/AGENTS.md` or `--system-prompt`    |
| `APPEND_SYSTEM.md`, `--append-system-prompt`                | `~/.agents/AGENTS.md`                         |
| `--system-prompt-template`, SDK `systemPromptTemplate`      | `--system-prompt` or SDK `systemPrompt`        |
| SDK `customSystemPrompt`, `appendSystemPrompt`              | SDK `systemPrompt`                             |
| SDK `systemPrompt` callback over the generated blocks       | SDK `fixedSystemPrompt`                        |
| `personality` setting, `PERSONALITY.md`                     | `~/.agents/AGENTS.md`                         |
| User `~/.omp/agent/RULES.md`                                | `~/.agents/AGENTS.md`                         |
| User-level context files from foreign tools                 | `~/.agents/AGENTS.md`                         |

Project `.omp/RULES.md` remains a sticky always-apply rule in the context block. See [Context files](./context-files.md).

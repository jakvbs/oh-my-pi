# Context files

Context files are Markdown instruction files that `omp` discovers automatically before a session starts and injects into the agent's project context. Use them for repository conventions, architecture notes, and test and review expectations that travel with a project. Context files are project-level only. Instructions that travel with a user account belong in the policy block, `~/.agents/AGENTS.md`; see [System prompt customization](./system-prompt-customization.md).

You never have to ask the agent to go read `AGENTS.md` files — the relevant ones are already discovered, loaded, and placed in context when the session begins.

## How context files relate to other concepts

Four similarly named things behave differently. Keep them straight:

- **Context files** are read as plain Markdown and shown to the agent in generated project instructions (inside `<repo-rules>` in the context block). They are session-opening instructions and background for repository work.
- **Sticky rules** come from a project `.omp/RULES.md`. They are converted into an always-apply rule whose full body is carried on every request, so it stays in context and keeps its hold even after the visible conversation grows. See "Sticky rules vs normal context" below.
- **Discovery providers** are the config-source adapters that know where each kind of OMP file lives. The full registry is `native`, `skillshare`, `omp-plugins`, `agent-plugins`, `agents`, `claude-plugins`, `agents-md`, `custom-context`, `mcp-json`, `ssh-json`, and `builtin-defaults`. Only some contribute context files (`native`, `agents`, `agents-md`, `custom-context`); the rest contribute other capabilities such as rules, MCP servers, skills, commands, hooks, tools, or SSH hosts. The same provider that contributes context files may also contribute MCP servers, slash commands, skills, hooks, tools, prompts, and settings.
- **Model providers** are inference backends such as `anthropic`, `openai`, `google`, `groq`, `ollama`, and `openrouter`. They have nothing to do with context files except that both kinds of id share the one `disabledProviders` list — see "Disabling discovery providers" below and [Providers](./providers.md).

Authoring **skills** and **rule** files (as opposed to the sticky `RULES.md`) is covered in [Skills](./skills.md). The user policy block (`~/.agents/AGENTS.md`, `--system-prompt`) is covered in [System prompt customization](./system-prompt-customization.md).

## Native `.omp` files

The native provider is the recommended format for new projects. It reads from `.omp/` directories inside a project, and it has the highest discovery priority, so its files win over every other convention at the same scope.

| File                                          | Scope   | Behavior                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.agents/AGENTS.md`                         | User    | Not a context file. It is the user policy block; see [System prompt customization](./system-prompt-customization.md).                                                                                                                              |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | Project | Project context, but only when `AGENTS.md` exists in the **nearest non-empty `.omp/` directory** found while walking from cwd toward the repository root. OMP does not continue to a farther `.omp/` directory when the nearest one lacks this file. |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | Project | Project sticky content, but only when `RULES.md` exists in the same nearest non-empty `.omp/` directory selected by the walk.                                                                                                                        |

Two details matter:

- **The nearest non-empty `.omp/` directory owns native project discovery.** Discovery starts in the current working directory and climbs toward the repository root. Once it finds a non-empty `.omp/`, it stops; native `AGENTS.md` and `RULES.md` are each read from that directory only. A missing file does not make discovery continue upward.
- **Empty directories and files contribute nothing.** An empty `.omp/` directory is skipped during the walk. In the selected non-empty directory, an empty `AGENTS.md` or `RULES.md` contributes nothing.

`~/.omp/agent` is shorthand for the active native agent directory. `PI_CODING_AGENT_DIR` relocates it. A named profile (`omp --profile <name>`, `OMP_PROFILE`, or `PI_PROFILE`) uses `~/.omp/profiles/<name>/agent` by default.

### Monorepo example

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

Starting a session in `repo/packages/api`:

- The native context file is `repo/packages/api/.omp/AGENTS.md` (the nearest one). `repo/.omp/AGENTS.md` is **not** also included.
- Because `repo/packages/api/.omp/` is the nearest non-empty native directory, project sticky content can only come from `repo/packages/api/.omp/RULES.md`. If that file is absent, `repo/.omp/RULES.md` is **not** used.

Put broad, durable project background in `AGENTS.md`. Reserve `RULES.md` for short, hard requirements that must stay visible across long conversations.

## Other context files

Besides native `.omp/AGENTS.md`, `omp` reads project `AGENTS.md` files in two other places. Configuration and instruction files of other agent tools (`CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.claude/`, `.codex/`, and the like) are not read. User-level files are never context; user-wide instructions belong in `~/.agents/AGENTS.md`.

| Provider id      | Convention path                         | Scope   | Notes |
| ---------------- | --------------------------------------- | ------- | ----- |
| `native`         | `.omp/AGENTS.md`                        | Project | Recommended OMP format. Read only from the nearest non-empty `.omp/` directory walking toward the repo root. |
| `agents`         | `.agent/AGENTS.md`, `.agents/AGENTS.md` | Project | Project files discovered while walking up from the current directory to the repository root. |
| `agents-md`      | `AGENTS.md`                             | Project | Standalone (non-config-directory) `AGENTS.md` files, discovered by walking up from the current directory to the repository root and, when that repository is nested under the user's home directory, through enclosing workspace directories up to but not including the home directory. With no repository root, discovery uses the home directory as the boundary for sessions under home and includes that boundary file. Files whose parent directory name starts with `.` are ignored — those belong to a config-directory provider instead. |
| `custom-context` | names in `contextFiles.extra`           | Project | Opt-in basenames such as `AGENTS.local.md`. Project walk matches `agents-md`, plus the primary checkout root when the session is a linked worktree. Additive: does not take or shadow the one-per-depth slot. Empty until configured. |

The discovery registry also holds providers that contribute no context files: `mcp-json` (MCP servers), `claude-plugins` (OMP marketplace plugins: skills, commands, rules, hooks, tools, MCP servers), `omp-plugins` (OMP plugins: skills, commands, rules, prompts, hooks, tools, MCP servers), `agent-plugins` (Agent Plugins standard packages: skills and MCP servers), `skillshare` (skills), `ssh-json` (SSH hosts), and `builtin-defaults` (built-in default rules). These matter for rules and other capabilities, and for the shared `disabledProviders` switch below.

## Extra filenames

Built-in discovery only recognizes `AGENTS.md`. List any other basename in `contextFiles.extra` to load it as well:

```yaml
# ~/.omp/agent/config.yml
contextFiles:
  extra:
    - AGENTS.local.md
```

You can also edit the **global** list in `/settings` → **Context** → **Extra Context Files**. Enter a JSON array such as `["AGENTS.local.md", "TEAM.md"]`; `[]` disables global extra files, while clearing the field removes the global override. The row is hidden when the project configuration (`.omp/config.yml`) sets `contextFiles.extra`, so a repository's list is never copied into your global config; edit or remove the project setting to change it. Start a new session to load the updated files.

The list is empty by default. Entries are file names, not paths — `../AGENTS.local.md` is rejected when settings load, as is the built-in name `AGENTS.md` (it already has providers, and listing it would duplicate a file or bypass shadowing). This is the configurable alternative to hard-coded `.local.md` sibling discovery ([#12496](https://github.com/can1357/oh-my-pi/pull/12496)): you choose the names, and an unset list discovers nothing.

Each name is found the same way as a standalone `AGENTS.md` (the `agents-md` walk: cwd up to the repository root, with the same home-directory boundary). A file whose parent directory name starts with `.` is skipped. Empty files contribute nothing.

When the session is in a linked git worktree, `<primary-checkout>/<name>` is also checked. The normal walk stops at the worktree's `.git`, so this is what picks up a gitignored `AGENTS.local.md` that lives only in the main checkout. Only the primary checkout's root is checked, not the directory matching your cwd inside it.

Extra files do not take the one-per-depth scope slot and are not shadowed by the file that does. `AGENTS.local.md` loads beside `AGENTS.md`. At the same depth the extra file is injected after the scope winner, so it is the more prominent of the two. `@` imports inside an extra file resolve from that file's own directory.

Turn one name off with `disabledExtensions` (`context-file:project:AGENTS.local.md`). Turn the provider off with `disabledProviders: [custom-context]`. Like every array setting, a higher-precedence layer replaces the list instead of appending to it.

## Load order and shadowing

When two providers describe the _same_ scope, the higher-priority provider wins. Full registry priorities:

| Priority | Provider id                    |
| -------: | ------------------------------ |
|      100 | `native`                       |
|       95 | `skillshare`                   |
|       90 | `omp-plugins`                  |
|       75 | `agent-plugins`                |
|       70 | `agents`, `claude-plugins`     |
|       10 | `agents-md`                    |
|        9 | `custom-context`               |
|        5 | `mcp-json`, `ssh-json`         |
|        1 | `builtin-defaults`             |

Discovered files are then deduplicated by scope:

- **Extra filenames do not use that slot.** A file from `contextFiles.extra` loads beside the scope winner. See [Extra filenames](#extra-filenames).
- **One project context file per directory depth.** Depth is measured from the current directory: the cwd is depth 0, its parent depth 1, and so on. Config subdirectories of an ancestor (`.agents/`, `.omp/`) count as the same depth as that ancestor.
- **At the same depth, the higher-priority provider shadows the rest.**
- **Across depths, multiple files survive.** In a monorepo, an ancestor `AGENTS.md` and a package-level one are different depths and both load.
- **Contained files are collapsed after import expansion.** A farther ancestor is omitted when a later, closer file contains its entire normalized paragraph sequence contiguously. This includes identical copies; paraphrased or interleaved paragraphs are not treated as duplicates.

Final injection order is farther project ancestors first, then project files closer to the cwd. Later files sit nearer the end of the generated context and are more prominent.

### Worked shadowing example

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .agents/AGENTS.md
```

Starting in `repo/packages/api`:

- `repo/AGENTS.md` is found by `agents-md` at depth 2 and kept.
- `repo/packages/api/AGENTS.md` (`agents-md`, priority 10) and `repo/packages/api/.agents/AGENTS.md` (`agents`, priority 70) both resolve to depth 0. The `agents` provider's higher priority shadows the package-level standalone `AGENTS.md`, so the `.agents/` file wins at that depth.
- The two kept files are ordered root-first, package-last, so `packages/api`'s file is the more prominent one.
- If you add `repo/packages/api/.omp/AGENTS.md`, `native` (priority 100) wins depth 0 outright, shadowing both lower-priority files.

## Injection behavior

Discovered context files are injected as one `<repo-rules>` block, with one `<file>` element per surviving file in the sort order above. The block lives in the trailing `<project-context>` system block, after the static system prompt, together with every other working-directory-derived section (`<dir-context>`, `<workspace-tree>`, `<workspace-roots>`), so sessions in different directories share the static prompt as a cached prefix:

```xml
<repo-rules>
MUST follow these context files for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.agents/AGENTS.md">
...package content...
</file>
</repo-rules>
```

The agent sees each file's absolute path and fully expanded Markdown content (with `@` imports already resolved).

Loading is automatic — there is no need to instruct the agent to search for `AGENTS.md` files during a session.

When workspace-tree scanning is enabled (`includeWorkspaceTree`), deeper-directory `AGENTS.md` files that were _not_ auto-loaded (for example, ones below the current directory) are surfaced separately in a `<dir-context>` block that lists their paths and tells the agent to read them before editing those directories. Those files are pointers, not full injected content.

## `@` imports

Inside any context file, an `@path` token expands inline to the referenced file's content before injection:

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

The exact rules:

- **Relative paths resolve from the importing file's own directory**, not the session's working directory.
- **`~/` and `~`** resolve from the user's home directory; absolute paths are used as-is.
- **Tokens inside fenced code blocks and inline code spans are left untouched** — useful when you want to _write about_ an `@token` without expanding it.
- **`git@github.com:org/repo.git` and `user@example.com`-style tokens are not treated as imports.** A token only counts when the `@` sits at the start of a line or after a space or tab.
- **Trailing sentence punctuation is trimmed** off the path (`. , ; : ! ? ) ] } " '`), so `@docs/setup.md.` imports `docs/setup.md`.
- **Imports recurse up to five hops.** An imported file may itself contain `@` imports, up to a total depth of five.
- **Repeated imports and cycles are skipped.** A file already pulled into the current expansion tree is not re-expanded, even from another branch; its later `@token` remains literal.
- **A missing or unreadable target leaves the original `@token` text in place** rather than erroring.

## Sticky rules vs normal context

Use a normal context file (`AGENTS.md`) for the bulk of your guidance: repository overview, code style, build and test commands, review expectations, and local conventions. These load into the opening generated project context.

Use a top-level **`RULES.md`** for the handful of hard requirements that must stay active even after a long conversation has pushed the opening context far up the transcript:

```markdown
# .omp/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` is special:

- It is read **only** from the nearest non-empty project `.omp/` directory selected by the cwd-to-repository-root walk. If that directory has no `RULES.md`, OMP does not fall back to a farther `.omp/RULES.md`. A `RULES.md` in the user agent directory is not loaded; user-wide hard requirements belong in `~/.agents/AGENTS.md`.
- It is loaded as an **always-apply rule**, not as a context file, so its full body is carried on every request — never demoted to an on-demand rulebook entry — and keeps its hold across long sessions. By default it rides in the system prompt; on vision models with `snapcompact.systemPrompt` imaging enabled the system prompt (this rule included) may instead ship as attached image frames, but the body travels with the request either way.
- It is re-discovered from disk when a session starts and on session-scoped rebuilds such as `/clear` and `/new`, so creating or editing it while OMP is running takes effect at the next reset — no restart required.
- It is **always sticky**: frontmatter cannot make it non-sticky. If you want conditional or opt-in behavior, write a normal rule file instead (see [Skills](./skills.md)).
- Its rule name is `RULES@project`. Rule deduplication is name-based, so avoid regular rules with that name: native regular rules load earlier and can shadow it.

Keep `RULES.md` short. Long background belongs in `AGENTS.md`; both generated context and always-apply rules occupy system-prompt context on requests.

## Disabling discovery providers

Turn a provider off with the `disabledProviders` setting in `~/.omp/agent/config.yml`, a project's `.omp/config.yml`, or a `--config` overlay:

```yaml
# .omp/config.yml
disabledProviders:
  - agents-md
```

`disabledProviders` is a **whole-provider switch with one shared id namespace**, used by two unrelated subsystems:

| Id kind                | Examples                                                                           | Effect when listed                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery provider ids | `native`, `agents`, `agents-md`, `custom-context`, `claude-plugins`, `omp-plugins`, `mcp-json` | The entire config source is removed — not just its context files, but also any MCP servers, slash commands, skills, hooks, tools, prompts, and settings it would have contributed. |
| Model provider ids     | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | The model backend is removed from selection even when its credentials are present. See [Providers](./providers.md).                                                                |

Ids are exact. Disabling a discovery provider is heavier than it looks — disabling `native`, for instance, also drops native MCP servers, commands, skills, hooks, tools, and settings, not only `.omp/AGENTS.md`. To drop the context file alone and keep everything else the provider contributes, use [`disabledExtensions`](#disabling-a-single-context-file) instead.

Only `enabledModels` and `disabledProviders` support **path-scoped** entries, so you can vary provider availability per subtree:

```yaml
disabledProviders:
  - custom-context # disabled everywhere
  - path: ~/work/legacy
    providers:
      - agents-md # disabled only under this directory
```

A scoped entry applies when the cwd equals the configured path or sits beneath it; `~` expands to home. Bare string entries apply everywhere.

Remember that higher-precedence settings layers **replace** array settings rather than appending to them. If your global config disables `agents-md` but a project config sets `disabledProviders: [custom-context]`, then inside that project `agents-md` discovery is re-enabled and only `custom-context` is disabled. See [Settings](./settings.md) for the full layer precedence, merge rules, and path-scoped array details.

## Disabling a single context file

`disabledProviders` removes a whole config source. To drop one context file and keep the rest of what its provider contributes, list its extension id in `disabledExtensions`:

```yaml
# ~/.omp/agent/config.yml, .omp/config.yml, or a --config overlay
disabledExtensions:
  - context-file:project:AGENTS.local.md
```

Context-file ids have the form `context-file:project:<basename>`, where `<basename>` is the file name with no directory part:

| Id                                  | Disables                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `context-file:project:AGENTS.md`    | **Every** project-level `AGENTS.md`, at each directory depth the walk reaches — the id carries no depth. |

The match is on level and file name only, so one entry covers every provider that contributes a file of that name at that level, and a project entry cannot be narrowed to a single depth. When you need per-directory control, use a project `.omp/config.yml` in the subtree that should differ, or the path-scoped `disabledProviders` form above.

Disabling is not the same as shadowing, and the difference is visible: a disabled file is dropped before deduplication, so it does not claim its scope. **The file it used to shadow is loaded in its place.** Because every built-in provider contributes the same basename, `context-file:project:AGENTS.md` leaves the scope with no built-in file at all.

A run driven by another program that needs different user instructions passes `--system-prompt`, which replaces the policy block for that run.

`disabledExtensions` is not path-scoped: only `enabledModels` and `disabledProviders` accept the `path:` form. Like every array setting it is replaced, not merged, by a higher-precedence layer.

Browse the ids interactively with `/extensions`, which lists every discovered context file with its level, source, and current state, and toggles the same setting.

## Troubleshooting

### A file is not loaded

- Native project context is read only from the nearest non-empty `.omp/` directory. That directory must contain a non-empty `AGENTS.md`; if it does not, discovery does not continue to a farther native directory.
- `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, and other tools' files are not read. Rename or link the file to `AGENTS.md`, or `@`-import it from one.
- User-level files are never context files. Use `~/.agents/AGENTS.md`.
- Empty files contribute nothing for the native and standalone providers.
- A disabled discovery provider contributes nothing — check `disabledProviders` across your global, project, and `--config` layers.
- A single file can also be turned off on its own. Check `disabledExtensions` for a matching `context-file:project:<basename>` entry, and remember that a project entry applies at every depth. `/extensions` shows the file as `disabled` when this is the cause.
- A name other than `AGENTS.md` is discovered only when it is listed in `contextFiles.extra`. A linked worktree does not see the primary checkout's copy unless that setting is set; the normal walk stops at the worktree.

### The wrong file wins

At one project depth, the higher-priority provider shadows the others (native > agents > agents-md). To force deterministic behavior, move your guidance into `.omp/AGENTS.md` (native always wins) or disable the competing discovery provider.

### User instructions are missing

User-wide instructions come only from the policy block, `~/.agents/AGENTS.md`, or `--system-prompt` when set. The path does not follow profiles or `PI_CODING_AGENT_DIR`, and `~/.omp/agent/AGENTS.md` is not read.

### A `RULES.md` file is ignored

Only the project `RULES.md` in the nearest non-empty `.omp/` directory selected from cwd toward the repo root is sticky. If a nearer non-empty `.omp/` directory exists, it blocks farther native directories even when it has no `RULES.md`. `<agentDir>/RULES.md` and a `RULES.md` anywhere else are not recognized.

### An `@` import did not expand

Confirm the target exists relative to the importing file (not the cwd). Imports inside fenced code blocks or inline code spans are intentionally left literal, `git@`/email-looking tokens are never imported, cycles are skipped, expansion stops after five hops, and a missing target leaves the original `@path` text unchanged.

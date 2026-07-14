## What to build

Add `omp --agent <name>` as a launch-time override that discovers an existing `AgentDefinition` and projects its portable fields onto the ordinary Main session. CLI flags remain authoritative; invalid selections fail before session creation or provider requests.

## Domain fit

Status: extension
Context: coding-agent root CLI startup and the existing task-agent catalog.
Existing sources: `.scratch/main-agent-profile/PLAN.md`, `src/main.ts`, `src/cli/args.ts`, `src/task/discovery.ts`, `src/task/types.ts`, `src/sdk.ts`, and existing CLI/session tests.
Delta: “agent profile” means an existing discovered `AgentDefinition` selected as Main launch defaults; no second definition format or persistent session identity is introduced.
Code mapping: argv Interface in `cli/args.ts`; root adapter and precedence in `main.ts`; skill autoload seam in `sdk.ts`; public tests in `test/cli-agent-flag.test.ts` and `test/session-fork-prompt-cache-key.test.ts`.

## Acceptance criteria

- [x] AC-001: `omp --agent <existing>` uses `discoverAgents(cwd)`/`getAgent` and preserves project > user > extensions/plugins > bundled precedence.
- [x] AC-002: profile prompt, tools, spawns, model, thinking, autoload skills, and read policy configure Main according to the plan mapping.
- [x] AC-003: profile `yield`, `output`, and `blocking` do not change Main completion or lifecycle; Main registry ID remains `Main`.
- [x] AC-004: explicit `--model`, `--thinking`, `--tools`/`--no-tools`, `--system-prompt`, `--append-system-prompt`, and `--no-skills` deterministically override profile defaults.
- [x] AC-005: `task.agentModelOverrides[name]` overrides `agent.model`, and `task.disabledAgents` rejects explicit selection.
- [x] AC-006: unknown selection exits 1 before a model request and reports sorted available names; disabled selection gives the specified `/agents` guidance.
- [x] AC-007: startup without `--agent` preserves the existing baseline.
- [x] AC-008: help exposes `--agent <name>` and argv accepts both `--agent reviewer` and `--agent=reviewer` without consuming the positional prompt or regressing profile bootstrap.
- [x] AC-009: explicit `--agent` invalidates an inherited fork/resume provider prompt cache key and remains launch-time only.
- [x] AC-010: known autoload skills are injected before first input; missing skills produce a profile-specific startup error; `--no-skills` wins.

## Test seam

`parseArgs` for public argv; exported `buildSessionOptions` with temporary project definitions and isolated settings/model registry for selection/projection; `createAgentSession` with an in-memory session and local skill for pre-input message injection; source CLI process for exit-code/stderr smoke.

## Reviewability budget

300–500 effective LOC including tests. Production behavior counts fully; direct contract tests partially. If SDK autoload exceeds roughly 100 effective LOC or requires lifecycle restructuring, split it into issue 02 while completing both slices in this implementation.

## Architecture notes

`discoverAgents` remains the sole discovery/precedence owner. A root-only adapter maps portable fields and deliberately removes parser-added `yield`; `spawns` adds `task` unless explicit tool flags replace the profile list. Existing deferred `modelPattern` and model-role resolution are reused. Read policy is an ephemeral `Settings.override`. SDK resolves selected skill names from its already-discovered skill snapshot and injects the same `buildSkillPromptMessage` custom message used by subagents before returning the session.

## Out of scope

Persistent profile identity in session files, Main registry/lifecycle changes, subagent promotion, aliases, a second agent format, task executor refactoring, and applying `output` or `blocking` to Main.

## Iteration log

### Iteration 2026-07-14 - Public Main agent profile - Plan

Goal: Deliver the complete public `omp --agent <name>` vertical slice.
Acceptance: AC-001 through AC-010.
Plan: RED public argv and selection tests; GREEN root projection; RED/GREEN precedence and cache shape; RED/GREEN SDK skill autoload; then end-to-end startup proof.
Budget: 300–500 effective LOC; decompose only if the autoload seam requires lifecycle restructuring or exceeds roughly 100 effective LOC.
Verify: `bun test packages/coding-agent/test/cli-agent-flag.test.ts`; `bun test packages/coding-agent/test/session-fork-prompt-cache-key.test.ts`; `bun check`; negative source CLI smoke must exit 1 with `Unknown agent` and no provider request; positive source smoke only when credentials are present.

### Iteration 2026-07-14 - Public Main agent profile - Outcome

Change: Added the public argv/help flag, root-only discovery and profile projection, explicit override ordering, disabled/unknown startup failures, prompt-cache shape invalidation, and an SDK seam that resolves and injects profile skills before first input.
Tests: RED observed 1 pass / 7 fail before implementation. GREEN: `bun test packages/coding-agent/test/cli-agent-flag.test.ts` passed 8 tests / 39 assertions; `bun test packages/coding-agent/test/session-fork-prompt-cache-key.test.ts` passed 6 tests / 26 assertions; `bun check` passed all repository packages. Negative source smoke exited 1 with the sorted `Unknown agent` message. Positive authenticated source smoke returned `/home/kuba/repos/oh-my-pi`.
Budget: Approximately 370 raw production/test LOC plus the local issue and changelog; the semantic slice stayed within the 300–500 effective-LOC reviewability budget. The SDK seam remained small and did not require a second issue.
Finding: Existing `discoverAgents`, deferred `modelPattern`, `Settings.override`, and `buildSkillPromptMessage` seams supported the full slice without task executor refactoring. The repository help renderer displays string flags as `--agent=<value>` while the description identifies the discovered agent definition; both accepted argv forms are contract-tested.
Decision: `--agent` remains launch-time only; profile name never becomes Main identity; `output` and `blocking` remain subagent-only; missing skills are fatal startup errors.
Next: Stop. AC-001 through AC-010 are green and both manual smoke paths were exercised.

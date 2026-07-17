## What to build

Make `/reload-plugins` reload disk-backed extensions in the live session, including their handlers, registered tools, and tool wrappers, without restarting OMP.

## Domain fit

Status: extension
Context: coding-agent plugin reload lifecycle
Existing sources: `packages/coding-agent/src/extensibility/extensions/runner.ts`, `packages/coding-agent/src/session/agent-session.ts`, mode-specific reload handlers
Delta: Reload currently refreshes capabilities, skills, and commands but leaves the startup `ExtensionRunner` and tool registry unchanged.
Code mapping: `AgentSession` owns the live runner/tool registry; slash-command runtimes invoke the reload seam.

## Acceptance criteria

- [x] Reload discovers a newly added extension and registers its tool in the current session.
- [x] Existing built-in tool wrappers use refreshed `tool_call` handlers immediately.
- [x] Removed extension tools and handlers no longer affect the current session after reload.
- [x] Interactive, RPC, and ACP `/reload-plugins` paths use the same extension refresh behavior.

## Test seam

`AgentSession.reloadExtensions()` plus the `/reload-plugins` runtime integration that invokes it.

## Reviewability budget

Up to 300 effective LOC across production and behavior tests. Decompose if reloading requires reconstructing the entire session rather than reconciling runner and extension-owned tools.

## Architecture notes

Keep the existing `ExtensionRunner` identity so already wrapped built-in tools remain valid. Replace its loaded extensions/runtime atomically, then reconcile extension-owned tools in `AgentSession` and rebuild active tools before the next model call.

## Out of scope

Changing extension source compatibility, hot-reloading arbitrary SDK inline extensions, or altering plugin installation semantics.

## Iteration log

### Iteration 2026-07-16 13:00 - live extension reload - Plan

Goal: Prove a live session can acquire a new extension tool and handler through `/reload-plugins`.
Acceptance: All criteria above.
Plan: Add a failing session-level reload test, introduce one shared reload seam, route all three runtime modes through it, and verify handler/tool replacement.
Budget: 300 effective LOC; split mode wiring from registry reconciliation if the slice exceeds it.
Verify: Run the focused extension reload test; success means a newly loaded tool exists, its handler blocks a built-in tool, and removed extension behavior disappears.

### Iteration 2026-07-16 13:30 - live extension reload - Outcome

Change: Added a live `ExtensionRunner` replacement seam, reconciled extension tools in `AgentSession`, supplied SDK rediscovery/provider refresh, and routed interactive, RPC, and ACP reload handlers through it.
Tests: RED reproduced `session.reloadExtensions is not a function`; GREEN passed `bun test test/agent-session-extension-reload.test.ts test/extensions-runner.test.ts` (122 tests), `bun test test/acp-agent.test.ts test/acp-builtins.test.ts` (47 tests), and `bun check`.
Budget: Stayed within the 300 effective-LOC budget; one production reload seam plus one behavior test.
Finding: Existing `ExtensionToolWrapper` instances can remain stable because they reference the runner; replacing runner contents rebinds their interception behavior without rebuilding the whole session.
Decision: `/reload-plugins` resets capability caches before extension rediscovery and atomically swaps handlers before reconciling tools.
Next: Stop; all acceptance criteria are executable and green.

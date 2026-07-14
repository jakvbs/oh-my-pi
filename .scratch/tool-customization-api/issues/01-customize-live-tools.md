# Customize live tools

## What to build

Add provider-independent `pi.patchTool` and `pi.wrapTool` registration APIs that customize the finalized initial live tool registry without reconstructing tool implementations or `ToolSession`.

## Domain fit

Status: extension
Context: Extension API and per-session tool registry.
Existing sources: `../SPEC.md`, `../PLAN.md`, `../acceptance-ledger.yaml`, extension runner tests, and the `sdk.ts` registry construction path.
Delta: A tool customization is an ordered transformation of a finalized live registry entry.
Code mapping: `ExtensionAPI`, extension loading/runtime storage, `ExtensionRunner`, and the pre-`ExtensionToolWrapper` registry seam in `packages/coding-agent/src/sdk.ts`.

## Acceptance criteria

- [x] `patchTool` changes only `description` and/or `label` while preserving the exact live execution contract.
- [x] `wrapTool` applies a validated partial override through a read-only facade with bound callbacks.
- [x] Customizations compose in extension load and call order against the final same-name registry winner.
- [x] Missing and invalid customizations are attributed, isolated, atomic, and do not block later registrations.
- [x] Customized tools remain inside standard approval and tool lifecycle interception.
- [x] Fresh session rebuilds do not stack wrappers.

## Test seam

Primary: initialize a coding-agent session with extension registrations, inspect the resulting provider/session tool catalog, and execute the live tool. Narrow runner tests prove registration snapshotting and ordering.

## Reviewability budget

250–400 effective LOC across production code and contract tests. Phase 0 artifacts and generated output are excluded. If the slice exceeds 400 effective LOC without late-MCP support, split `wrapTool` from the metadata-only `patchTool` slice.

## Architecture notes

Registrations are deferred until the finalized initial `toolRegistry` exists. The registry value is the source of truth. Apply customizations after built-ins and same-name extension/SDK tools, before `ExtensionToolWrapper`. Never spread or mutate a class instance; expose a read-only facade whose callbacks are bound to the current live receiver. Compute and validate each candidate before replacing the registry entry.

## Out of scope

Late-discovered MCP tools, advisor-only tool pools, configuration-file syntax, asynchronous decorators, mutable tool names, compatibility aliases, and reconstruction of built-in tools or `ToolSession`.

## Iteration log

### Iteration 2026-07-14 16:59 - registration API - Plan

Goal: Establish deferred `patchTool`/`wrapTool` registration with deterministic ordering and snapshotted metadata patches.
Acceptance: Enabling seam for ledger case `metadata_patching/patches built-in description in session catalog` (AC-001), before live registry application.
Plan: Add runner-level RED tests for both APIs, call order, and patch snapshotting; then add the smallest public types and runtime/runner storage required to make them GREEN.
Budget: 250–400 effective LOC for the complete reviewed slice; split `wrapTool` if the full slice exceeds 400 effective LOC without late-MCP scope.
Verify: `bun test packages/coding-agent/test/extensions-runner.test.ts`; success is zero failures including the new registration/order tests.

### Iteration 2026-07-14 17:03 - registration API - Outcome

Change: Added public metadata/decorator types, `ExtensionAPI.patchTool`/`wrapTool`, per-extension ordered storage, patch snapshotting, runner aggregation, and a registration-order contract test.
Tests: RED: `bun test packages/coding-agent/test/extensions-runner.test.ts` failed with `getAllToolCustomizations is not a function` (39 pass, 1 fail). GREEN: the same command passed (40 pass, 0 fail).
Budget: The complete slice remains within the 250–400 effective LOC budget.
Finding: Deferred registrations fit the existing per-extension load model; an array is required to preserve repeated same-name calls.
Decision: Registry targets remain unresolved during extension loading. Patch objects are copied at registration time.
Next: Prove AC-001/AC-002 at the live session registry and execution seam.

### Iteration 2026-07-14 17:03 - live metadata and execution - Plan

Goal: Apply the first customization case to the finalized live registry while preserving the exact stateful execution call.
Acceptance: AC-001 `metadata_patching/patches built-in description in session catalog` and AC-002 `metadata_patching/preserves exact execution call contract`.
Plan: Add a session-level description test plus a class-based custom-tool execution probe, then implement atomic registry transformation before `ExtensionToolWrapper`.
Budget: 250–400 effective LOC for the complete reviewed slice; split `wrapTool` if the full slice exceeds 400 effective LOC without late-MCP scope.
Verify: `bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts`; success is patched provider-visible metadata, exact argument identities, one original invocation, and zero failures.

### Iteration 2026-07-14 17:12 - live metadata and execution - Outcome

Change: Applied deferred metadata patches to the finalized initial registry before `ExtensionToolWrapper`; added session-level description, label, empty-patch, and exact stateful execution proofs.
Tests: RED: both session tests failed with original descriptions. GREEN: `bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts` passed with 53 tests and 0 failures after the complete continuation.
Budget: Raw production and contract-test additions exceeded 400 LOC once full decoration/fault coverage was included. Per the decomposition trigger, metadata-only `patchTool` closes here and `wrapTool` continues in `02-wrap-live-tools.md`.
Finding: A proxy facade over the final registry value preserves prototype methods, private state, signal identity, update callback identity, and exact result values.
Decision: `patchTool` accepts only `description` and `label`; an empty patch preserves the current tool. Full partial overrides belong exclusively to `wrapTool`.
Next: Continue and close `wrapTool` in `02-wrap-live-tools.md`.

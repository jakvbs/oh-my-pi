# Wrap live tools

## What to build

Complete the `pi.wrapTool` escape hatch over the finalized initial live tool registry after the metadata-only `patchTool` seam established in issue 01.

## Domain fit

Status: extension
Context: Extension API and per-session tool registry.
Existing sources: `../SPEC.md`, `../PLAN.md`, `../acceptance-ledger.yaml`, and `01-customize-live-tools.md`.
Delta: A decorator receives a read-only bound facade and returns an atomic partial override.
Code mapping: `ExtensionRunner.applyToolCustomizations`, pre-`ExtensionToolWrapper` registry seam, session-level customization tests.

## Acceptance criteria

- [x] Decorators can delegate to bound stateful class execution.
- [x] Supported schema, policy, execution, and renderer fields override while omitted fields remain live.
- [x] Customizations compose in deterministic registration order against the same-name winner.
- [x] Approval and `tool_call`/`tool_result` interception remain outside customized execution.
- [x] Missing, thrown, invalid, and rename attempts are attributed, isolated, and atomic.
- [x] Fresh session registries apply each wrapper exactly once.

## Test seam

Session-level provider-visible catalog and live execution through `session.agent.state.tools`; focused `ExtensionToolWrapper` approval contract for the standard gate.

## Reviewability budget

This continuation isolates the `wrapTool` behavior from the metadata-only issue 01 slice because the aggregate raw diff exceeded the 250–400 effective LOC budget. Test fixture/setup and issue/ledger artifacts are excluded from semantic LOC, but both slices remain separate review units.

## Architecture notes

The facade is frozen and forwards callable properties bound to the current live receiver. Candidates proxy the previous valid tool and define only validated supplied overrides. Registry replacement occurs only after complete synchronous decoration and validation.

## Out of scope

Late MCP insertion, advisor pools, async decorators, mutable tool names, compatibility shims, and tool/session reconstruction.

## Iteration log

### Iteration 2026-07-14 17:12 - wrap composition and isolation - Outcome

Change: Added bound read-only facades, validated partial overrides, deterministic composition, same-name precedence, lifecycle/approval placement, fresh rebuild behavior, and attributed failure isolation.
Tests: RED was established by the initial session tests (unmodified descriptions and execution); GREEN: `bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts` passed with 53 tests and 0 failures.
Budget: The aggregate raw diff exceeded 400 LOC, so `wrapTool` is recorded as this separate continuation slice per `PLAN.md`; no late-MCP or advisor scope was added.
Finding: Existing `applyToolProxy` preserves class-private receiver semantics without spreading or mutating live instances. Applying customization before `ExtensionToolWrapper` preserves approval and lifecycle interception.
Decision: Each registration computes a complete candidate before registry replacement; failures retain the prior valid entry and later registrations continue.
Next: Update the acceptance ledger, public extension documentation, and changelog; then run package checks and the ledger verifier.

### Iteration 2026-07-14 17:18 - final contract gate - Outcome

Change: Documented both APIs in `docs/extensions.md`, added the coding-agent changelog entry, and marked all 15 ledger cases implemented with executable test traceability.
Tests: `bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts` passed (53 tests, 0 failures); `bun run check` in `packages/coding-agent` passed; the acceptance-ledger report shows 13/13 criteria implemented, 0 pending cases, 100% progress.
Budget: Metadata patching and live decoration remain split between issues 01 and 02. No out-of-scope late registry support was added.
Finding: Session-level catalog and execution tests are sufficient automated proof; no manual evidence remains pending.
Decision: Ledger commit traceability is explicitly `uncommitted` because repository rules prohibit committing without a direct user request.
Next: Stop; implementation and contract gates are complete.

### Iteration 2026-07-14 17:24 - real OMP RPC smoke - Outcome

Change: Launched the real source CLI entrypoint in RPC mode with an explicit extension applying both `patchTool` and `wrapTool` to `read`, then queried `get_state`.
Tests: `bun packages/coding-agent/src/cli.ts --mode rpc --no-session --extension /tmp/omp-tool-customization-e2e.ts --no-lsp` emitted `ready`; the successful `get_state` response contained both `E2E_PATCHED_READ` and `E2E_WRAPPED` in `dumpTools.read.description`.
Budget: No product code changed; the temporary extension was deleted after the smoke run.
Finding: The real CLI extension loader and finalized session registry expose the composed description through RPC without a model request.
Decision: Actual CLI startup/catalog wiring is now directly observed. Tool execution through a provider turn was not invoked because it would require an external model request; exact live execution remains covered by the session-level contract test.
Next: Stop.

# Test evidence and safety

## Applies when
- Primary sources are tests, fixtures, or runner configuration.
- A supplied verdict claims verified behavior, determinism, isolation, cleanup, suite safety, or a bug fix.

## Not for
- Treating test source as proof that execution passed.
- Treating unavailable runtime proof as an automatic defect or unit-wide insufficiency.
- Assigning unrelated infrastructure or suite failure to the reviewed change.

## Checks

### TEST-DETERMINISM — Deterministic test
- Applies when a test or supplied execution record supports a verdict.
- Used time, randomness, scheduling, and external inputs MUST be controlled; random failures MUST retain replay seed/data.
- A statically visible uncontrolled wall-clock sleep, randomness, iteration order, or race MAY prove a major test defect.
- Differing supplied outcomes for identical revision, inputs, and configuration are a major defect.
- Otherwise, missing repeated execution is only a named verification gap when determinism is claimed.
- Evidence MUST show test/fixtures and any supplied comparable execution records.

### TEST-ISOLATION — Independent of predecessor and order
- Applies to one named clean-versus-predecessor/order pair touching mutable shared resources.
- Both supplied runs MUST produce the same result for identical explicit inputs and configuration.
- Different outcomes are a major defect; statically proven leaked global state MAY also be a finding.
- Contracted suite fixtures are excluded when both cases begin at the same enforced fixture boundary.
- Missing paired execution is only a verification gap when isolation is material to the verdict.

### TEST-RESOURCE-CLEANUP — Resource cleanup
- Applies to one named path responsible for one mutable resource at a declared cleanup boundary.
- The resource MUST reach its required final state at that boundary.
- Statically visible missing cleanup or a supplied post-run probe showing leaked state is a major defect.
- Process- or suite-lived resources are judged at their declared boundary.
- Evidence MUST show setup/cleanup path, resource postcondition, and any supplied probe.

### TEST-FULL-SUITE-SAFETY — Full-suite safety
- Applies when tests, fixtures, runner configuration, or shared test resources change.
- A suite-safety claim requires a supplied complete relevant-suite record where the test ran without retry, quarantine, or hiding filter.
- A supplied suite failure causally tied to collision, leak, timeout, deadlock, order, skip, or retry is a major defect.
- Missing suite execution is a verification gap only when the verdict depends on suite safety.
- Evidence MUST show suite manifest/configuration, record, and causal location for failures.

### TEST-VERDICT-COVERAGE — Verdict proportional to coverage
- Applies when context claims behavior, invariant safety, error correctness, lifecycle correctness, or a fix.
- Every material claim MUST map to an observable scenario covering its relevant boundary, error, or transition.
- A broad claim supported only by happy path, or a named unasserted case in a complete supplied inventory, is a major defect.
- Representative equivalence classes suffice when contract and paths establish equal risk.
- Evidence MUST show exact verdict scope, complete relevant test inventory, contracts, and material risks.

### TEST-RUNNABLE-PROOF — Runnable proof of key behavior
- Applies only when context claims behavior works, tests pass, regression is absent, or readiness is verified.
- A supplied completed record MUST identify the reviewed revision, command, scenario, assertion result, and runner exit.
- A relevant executed assertion failing on the behavior is a major defect.
- A complete inventory proving no runnable scenario observes the claimed behavior is a major defect.
- No execution record means a named verification gap, NEVER an automatic defect or unit-wide insufficiency.
- Static proof MAY substitute only for a wholly static contract with supplied checker evidence.

### TEST-BUG-BEFORE-AFTER — Bug reproduced before and after
- Applies when context claims an existing bug or regression was fixed.
- Comparable records MUST show the same scenario and oracle failing with the named symptom before and passing after.
- A passing before record, recurring after symptom, or materially changed scenario/oracle/environment defeats the fix claim and is a major defect.
- Historical CI MAY supply the before side when revision, scenario, oracle, and symptom are identified.
- Missing before/after records are a named verification gap only when the fix verdict depends on them.
- Evidence MUST identify both revisions, scenario, oracle, records, and symptom.

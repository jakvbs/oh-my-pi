# Interfaces and locality

## Applies when
- A change adds or modifies a module, interface, helper, wrapper, or layer.
- Review concerns caller knowledge, depth, leverage, locality, or layering.

## Not for
- New abstraction justified only by hypothetical flexibility or easier mocking.
- Text duplication or call counts without a demonstrated semantic cost.

## Checks

### MOD-INTERFACE-KNOWLEDGE — Interface limits caller knowledge
- Applies when a changed interface has at least one caller.
- Callers MUST provide public-contract data without coordinating internal retry, ordering, cache, defaults, or state.
- Leaking required implementation choreography is a major defect.
- Evidence MUST show interface, implementation, representative caller, and disputed public policy.

### MOD-DELETION-DEPTH — Boundary survives deletion test
- Applies when a module or wrapper is added, removed, or materially changed.
- Removing it SHOULD force callers to absorb named behavior, policy, invariant, translation, or a required boundary.
- Direct substitution without knowledge or contract change is a minor defect.
- Evidence MUST show the boundary, all affected callers, and a concrete deletion simulation.

### MOD-LEVERAGE — Interface operation provides leverage
- Applies to one named operation and representative caller.
- The operation SHOULD express intent while hiding a named step, decision, or invariant.
- One-to-one delegation exposing implementation options is a minor defect unless the low-level mechanism or boundary is itself the contract.
- Evidence MUST show operation, implementation, use, and abstraction-level contract.

### MOD-CHANGE-LOCALITY — Declared change stays with owner
- Applies only when locality is claimed or an explicit change requirement/probe exists.
- The named behavior change SHOULD remain with one owner; unrelated callers and representations SHOULD retain their contracts.
- Repeating one semantic edit across independent callers or representations is a major defect.
- Public-contract migrations and generated derivatives are excluded.
- Evidence MUST include the exact change, owner, callers, representations, and simulation or equivalent diff.

### MOD-SAME-OPERATION-LAYERING — Layers change semantic level
- Applies when a path crosses at least two local layers or wrappers.
- Adjacent layers SHOULD add intent, policy, translation, effect, or a real enforced boundary.
- Repeating the same operation and arguments through pass-through layers is a minor defect.
- Framework, transaction, authorization, idempotency, observability, and process boundaries are excluded when proven.
- Evidence MUST show the full call path and each layer's responsibility.

### MOD-CALLER-BEHAVIOR — Caller invokes owned behavior
- Applies when a caller reads or writes multiple state elements from one owner for one operation.
- The caller SHOULD invoke intent-revealing owner behavior instead of getter/setter choreography.
- Reconstructing a decision and write order from owner fields is a major defect.
- Pure presentation, boundary mapping, and one-off migration are excluded.
- Evidence MUST show the caller operation, owner API, and governing invariants or tests.

### ABSTRACTION-CALLER-KNOWLEDGE — Abstraction removes caller knowledge
- Applies when a helper, function, class, or module is extracted for callers.
- The abstraction SHOULD replace a named concept, decision, or sequence; callers SHOULD NOT retain its step selection and order.
- Moving identical code while preserving caller choreography is a minor defect.
- Stable-rule deduplication and isolation of dangerous mandatory checks are excluded.
- Evidence MUST show caller, full abstraction, baseline or equivalent use, and hidden contract.

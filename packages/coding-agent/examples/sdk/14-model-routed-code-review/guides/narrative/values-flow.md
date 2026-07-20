# Values and flow

## Applies when
- Review concerns side-effect visibility, value roles or units, branching ownership, or readability metrics.

## Not for
- Pure transformations without external effects.
- Metrics not used to justify a verdict or refactor.
- A single stable local branch implementing caller-owned behavior.

## Checks

### COG-1 — Side-effect category is visible
- Applies to one located I/O, escaping mutation, event publication, or callback registration.
- Operation surface MUST reveal the same effect category through name, type, signature, annotation, or direct contract.
- Hidden or falsely pure effects are major defects.
- Framework lifecycle effects and non-escaping fresh-value mutation are excluded.
- Evidence MUST show effect site, operation surface, and any lifecycle or escape facts.

### COG-2A — Value semantic role
- Applies to one primitive or same-typed value whose role affects comparison, conversion, arithmetic, or a call.
- Name, type, field, or named parameter MUST communicate that role at the operation.
- Requiring assignment tracing or communicating a different role is a minor defect.
- Conventional short indices/accumulators are excluded in unambiguous local scopes.
- Evidence MUST show declaration, operation, and role-defining contract or competing role.

### COG-2B — Value unit
- Applies to one numeric or quantitative value whose unit affects an operation.
- Type, name, suffix, or local boundary contract MUST communicate the used unit.
- Missing or contradictory units are minor defects.
- Strong unit types need no repeated suffix.
- Evidence MUST show declaration, operation, and unit-defining type, contract, or conversion.

### FLOW-1 — Branch decision locality
- Applies to branch or dispatch on a stable status, kind, mode, state, or flag.
- One owner, dispatcher, or transition table SHOULD own each selection rule.
- Repeating the same rule in independent callers is a minor defect.
- Different layer policies and one stable local condition are excluded.
- Evidence MUST show all claimed branches, scope, and matching decision semantics.

### METRIC-1 — Metric is signal, not verdict
- Applies when complexity, nesting, branch count, length, or similar threshold justifies a negative verdict or refactor.
- The metric MUST only locate a hotspot; independent evidence MUST identify ambiguity, hidden flow, level shift, or needless navigation.
- A number or threshold as sole justification is a minor defect in the review rationale.
- A hard tooling threshold MAY be a separate policy violation, not narrative proof.
- Evidence MUST show the metric claim and every localized semantic cost offered as justification.

# State and lifecycle

## Applies when
- Code constructs or mutates invariant-protected state.
- Code changes a domain model, value object, or lifecycle transition.

## Not for
- Raw DTOs, transport records, pre-validation builders, caches, or presentation state without a declared invariant.
- Intermediate representations barred from persistence and domain operations before validation.

## Checks

### STATE-01 — Exclude forbidden state
- Applies when a declared invariant forbids one reachable state variant.
- The public path MUST reject the variant before persistence, or representation MUST make it impossible.
- A successful or persisted forbidden variant is a critical defect.
- Evidence MUST identify the invariant, public path, and available negative, schema, type, property, or model proof.

### STATE-02 — Public construction postcondition
- Applies when a public constructor, factory, deserializer, or adapter has a named valid input class and postcondition.
- Valid input MUST produce the declared domain object or value object satisfying that postcondition.
- Rejecting valid input or returning an object violating the postcondition is a major defect.
- Evidence MUST identify the public path, valid input class, postcondition, and any available behavioral proof.

### STATE-03 — Mutation preserves invariant
- Applies when a public mutation changes protected state governed by one named post-operation invariant.
- Success and rejection paths MUST preserve the invariant; rejection MUST NOT leave partial invalid state.
- A concrete final state violating the invariant is a critical defect.
- Evidence MUST show the mutation, invariant, before/after state, and available boundary/error-path proof.

### STATE-04 — Lifecycle transition admissibility
- Applies when a contract classifies one source-state and operation pair.
- The operation MUST accept an allowed pair and reject a forbidden pair with the declared error.
- Contrary acceptance or rejection is a critical defect.
- Evidence MUST identify the authoritative transition rule, operation, and available table or model proof.

### STATE-05 — Lifecycle target state
- Applies when an accepted transition declares one target state.
- The observed post-transition state MUST equal that target.
- A different final state is a critical defect.
- Evidence MUST identify the transition rule, operation, and available post-state proof.

### DATA-VALUE-OBJECT-INVARIANT — Value object owns meaning
- Applies when a change adds or modifies a value object or replaces a primitive.
- Construction or operations MUST centralize an invariant, normalization, unit, or identifier distinction.
- A get/set wrapper that leaves validation or interpretation in callers is a minor defect.
- Nominal typing is sufficient when it prevents a contractually observable unit or identifier mix-up.
- Evidence MUST show construction, operations, callers or baseline, and the protected meaning.

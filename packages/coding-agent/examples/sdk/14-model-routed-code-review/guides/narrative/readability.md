# Language and readable flow

## Applies when
- Review concerns names, terminology, entry points, helpers, abstraction level, navigation, or visible control flow.

## Not for
- Correctness, performance, security, or test completeness without a communication defect.
- Demanding domain metaphors from technical code with a clear technical contract.
- Numeric complexity, nesting, branch, or length thresholds without localized semantic cost.

## Checks

### LANG-1 — Domain contract names
- Applies to one owned symbol implementing a declared domain rule, decision, event, or operation.
- Its name plus owner type MUST communicate the implemented concept and decision.
- A contradictory or non-informative name requiring implementation inspection is a major defect.
- Protocol-mandated names are excluded when owner context reveals meaning.
- Evidence MUST show symbol, behavior, domain contract, and any overriding protocol declaration.

### LANG-2 — Technical transformation or boundary name
- Applies to an owned entry point for transformation, adaptation, serialization, validation, transport, or boundary protection.
- Name plus owner, signature, or local contract MUST identify the actual transformation or boundary.
- Generic or contradictory naming is a major defect when surface context cannot disambiguate it.
- Framework- or protocol-mandated names are excluded when context identifies the operation.
- Evidence MUST show name, signature, direct operations, and any governing protocol.

### LANG-3 — Terminology consistency
- Applies when a concept or term appears in multiple reviewed locations or allowed sources.
- One term MUST keep one meaning; alternate terms MUST have a visible translation boundary or glossary mapping.
- Unmapped meaning changes or synonyms that force guessed translation are major defects.
- Evidence MUST show at least two uses and any type, mapping, or glossary resolving equivalence.

### NARR-1A — Entry-point surface contract
- Applies to one entry point and one named input-to-result, error, or postcondition pair.
- Name, signature, return type, or direct contract MUST communicate that pair and match implementation facts.
- Requiring helper inspection or communicating a contrary result is a major defect.
- State-machine tables and typed pipelines MAY express the pair declaratively.
- Evidence MUST show entry surface, named pair, and localized implementation result.

### NARR-1B — Entry-point step order
- Applies to one flow containing at least two direct material steps.
- Names and structure MUST reveal step order without opening helper implementations and MUST match control flow or composition order.
- Hidden, misleading, or contrary order is a major defect.
- Declarative pipelines and state transitions MAY express order through composition.
- Evidence MUST show the complete direct flow and path-sensitive or declarative order.

### NARR-2 — Helper refinement
- Applies when a flow calls an owned helper representing a named step.
- Every material helper operation SHOULD refine that named step.
- Hidden peer phases, decisions, or results are a minor defect.
- Multiple operations forming one invariant, transaction, or technical boundary are excluded.
- Evidence MUST show callsite, full helper, and hidden phase or shared invariant.

### NARR-3 — Consistent abstraction level
- Applies when a function contains at least two material operations.
- Statements SHOULD remain at the decision or execution level required by the named responsibility.
- Interleaving unrelated representation detail or an unannounced higher-level policy is a minor defect.
- Short cohesive transformations and inline atomic invariants are excluded.
- Evidence MUST show the full function, responsibility, and compared operations.

### NARR-4 — Proportional navigation cost
- Applies when understanding main flow requires following definitions, aliases, or contracts.
- Every required hop SHOULD add a named contract, invariant, policy, or real boundary.
- A necessary pass-through hop adding no meaning is a minor defect.
- Framework, port-adapter, process, and stable public API boundaries are excluded when visible.
- Evidence MUST show the entry point, every disputed hop, and the fact requiring navigation.

### NARR-5 — Main-flow visibility
- Applies to a sequence, branch, pipeline, or state transition representing operational flow.
- Main transitions MUST remain traceable; alternatives and errors SHOULD be locally named, returned, or structurally separated.
- Dispersed conditions, unrelated nesting, or implicit callback order hiding transitions are major defects.
- Exhaustive matches and explicit state machines need not privilege one happy path.
- Evidence MUST show the complete flow and every branch or callback controlling material order.

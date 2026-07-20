# Policy ownership

## Applies when
- Multiple locations define or enforce one invariant, default, mapping, or boundary policy.
- A caller decides from state owned elsewhere.

## Not for
- Similar syntax encoding independent domain rules.
- Derived boundary validation mechanically tied to one authoritative definition.
- Explicit composition of distinct layer policies with declared precedence.

## Checks

### OWNER-01 — Invariant definition owner
- Applies when at least two locations define or enforce the same invariant.
- One location MUST own the invariant's meaning; other enforcement MUST derive from or remain mechanically equivalent to it.
- Independent competing definitions are a major defect even while textually equal.
- Evidence MUST identify all definitions/enforcers, the owner, and any available conformance proof.

### OWNER-02 — Default owner
- Applies when a change adds, changes, or duplicates a value used for missing input.
- Every path in one use-case scope MUST obtain the default from its declared owner.
- Divergent caller defaults or a data source imposing use-case policy are major defects.
- Evidence MUST identify values, application sites, use-case scope, owner, and available missing-value proof.

### OWNER-03 — Mapping owner
- Applies when multiple locations map the same input/output domains and version.
- One mapping MUST be authoritative; derivatives MUST be generated or complete-set equivalent.
- Different outputs for identical input, scope, and version are a major defect.
- Evidence MUST identify mappings, domains, versions, owner, and available generated/schema/table proof.

### OWNER-04 — Boundary policy owner
- Applies when retry, timeout, ordering, or cache behavior for one operation spans layers.
- One declared owner MUST control the policy; derived layers MUST NOT recreate or contradict it.
- Conflicting limits, order, cache periods, or retry conditions are major defects.
- Evidence MUST identify every policy site, operation scope, owner, and available runtime composition proof.

### MOD-POLICY-OWNERSHIP — Data owner decides
- Applies when code decides from state owned by a module or domain object.
- The state owner SHOULD expose behavior or a decision; callers MUST NOT reconstruct its rule from fields.
- Caller-side domain decisions, especially repeated ones, are major defects.
- Presentation-only reads and orchestration across peer owners are excluded.
- Evidence MUST identify state ownership, invariant enforcement, decision code, caller, and disputed domain contract.

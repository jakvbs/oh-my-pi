# Seams and representation

## Applies when
- A change adds or modifies a seam, adapter, DTO, mapper, shared abstraction, or canonical representation.

## Not for
- A seam justified only by a test mock or hypothetical variant.
- Separate wire, persistence, and domain forms protecting genuinely different contracts.

## Checks

### SEAM-REAL-VARIATION — Seam represents real variation
- Applies when adding or changing an interface, strategy, plugin, or substitution point.
- Evidence MUST show distinct variants, a real process/vendor/storage boundary, platform requirement, or approved concrete substitution.
- One variant without a boundary or requirement is a major defect when the seam exists only for mocks or future speculation.
- Evidence MUST identify definitions, implementations, selection site, and variation contract.

### ADAPTER-BOUNDARY-ISOLATION — Adapter isolates external contract
- Applies to external API, transport, storage, SDK, or wire adapters.
- Vendor types, errors, auth, retry, and protocol semantics SHOULD stop at the adapter.
- Leakage into domain callers without a declared gateway contract is a major defect.
- A thin sole dependency on a generated client MAY still protect a stable system contract.
- Evidence MUST show both boundary contracts, adapter mapping, and a domain caller.

### DATA-CANONICAL-REPRESENTATION — One internal canonical representation
- Applies when one concept appears in multiple structures, DTOs, models, or mappings.
- One representation SHOULD drive internal logic; other forms SHOULD exist only at named boundaries.
- Competing equivalent internal forms requiring repeated mapping are a major defect.
- A time-bounded migration with conformance proof is excluded.
- Evidence MUST show all representations, mappers, logic sites, and boundary contracts.

### ABSTRACTION-SHARED-CONTRACT — Shared abstraction joins one contract
- Applies when previously independent places are combined behind an abstraction, generic, or base class.
- Combined implementations MUST share an invariant and change for the same semantic reason.
- Similar text or current data shape without a shared contract is a major defect.
- Stateless technical operations with a stable technical contract are excluded.
- Evidence MUST show implementations, callers, shared invariant, and a credible common or divergent change.

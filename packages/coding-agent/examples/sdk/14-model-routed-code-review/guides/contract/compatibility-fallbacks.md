# Compatibility and fallbacks

## Applies when
- Code adds, changes, or preserves legacy-version, rollout, protocol-variant, or fallback paths.

## Not for
- Removing a path without authoritative support/version/rollout evidence.
- Intentional best-effort behavior whose public result matches its contract.

## Checks

### COMPAT-01 — Compatibility variant remains supported
- Applies when a branch claims an older version, partial rollout, or protocol variant.
- Support data MUST place that variant inside the active time and deployment scope.
- A branch for an explicitly unsupported variant without another contract is a major defect.
- Evidence MUST identify support/version/rollout scope and the branch predicate.

### COMPAT-02 — Compatibility variant result
- Applies when a supported variant declares a public result.
- The branch MUST return exactly that result.
- A contrary result is a major defect.
- Evidence MUST identify the variant contract, branch behavior, and available contract proof.

### FALLBACK-01 — Fallback trigger
- Applies when a contract defines one fallback inclusion or exclusion condition.
- The fallback MUST run for the included condition and MUST NOT run for the excluded condition.
- Contrary triggering is a major defect.
- Evidence MUST identify the trigger contract, predicate, and available controlled-condition proof.

### FALLBACK-02 — Fallback public result
- Applies when a triggered fallback declares a public result.
- The fallback MUST return exactly that result.
- A contrary result is a major defect.
- Evidence MUST identify the result contract, fallback implementation, public boundary, and available observation.

### FALLBACK-03 — Required or forbidden fallback effect
- Applies when a triggered fallback requires or forbids one named effect.
- The required effect MUST occur; the forbidden effect MUST NOT occur.
- Contrary behavior is a major defect.
- Evidence MUST identify the effect contract, fallback and effect implementation, and available observation.

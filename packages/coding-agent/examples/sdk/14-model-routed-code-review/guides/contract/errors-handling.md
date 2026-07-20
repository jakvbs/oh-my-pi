# Errors and handling

## Applies when
- Public operations expose domain failures.
- Catch, conversion, fallback, or early-return paths change error outcomes or effects.

## Not for
- Causes intentionally aggregated by the public contract with no distinct caller response.
- Best-effort absence or cleanup that matches its declared contract.

## Checks

### ERROR-01 — Distinguishable public domain error
- Applies when one failure cause requires callers to react differently.
- A public result, error type, code, or documented exception MUST distinguish the cause.
- Returning indistinguishable false, null, generic failure, or apparent success is a major defect.
- Evidence MUST identify the failure contract, caller response, public representation, and available boundary proof.

### ERROR-02 — Public error-handling result
- Applies when a named error has a declared public handling result.
- Catch, conversion, fallback, or early return MUST produce exactly that result.
- Swallowing the error or presenting failure as contrary success is a critical defect.
- Evidence MUST identify the result contract, handling site, public boundary, and available controlled-error proof.

### ERROR-03 — Required or forbidden handling effect
- Applies when handling one error requires or forbids one named effect.
- The required effect MUST occur; the forbidden effect MUST NOT occur.
- Contrary behavior is a critical defect.
- Evidence MUST identify the effect contract, handler, effect implementation, and available controlled-error observation.

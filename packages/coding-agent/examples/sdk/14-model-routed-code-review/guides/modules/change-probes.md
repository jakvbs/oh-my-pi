# Explicit change probes

## Applies when
- The review request or allowed source supplies one explicit future change probe.
- The probe names the new threshold, rule, state, vendor difference, or scenario.

## Not for
- Invented future requirements.
- General flexibility, extensibility, or testability claims without a concrete probe.
- Absence of a probe; that makes this entire lens inapplicable, not insufficient.

## Checks

### PROBE-POLICY-CHANGE — Change one threshold or rule
- Applies when the probe supplies an exact new threshold or rule.
- The simulated decision change SHOULD touch one semantic owner; inputs, contract tests, and generated derivatives MAY also change.
- Manual edits to the same decision across independent owners are a major defect.
- Evidence MUST cite current decision owners and duplication sites. Put the supplied rule and simulated edit placement in `reason`.

### PROBE-STATE-VARIANT — Add one state or variant
- Applies when the probe defines a concrete variant and required behavior.
- Variant recognition SHOULD remain with its owner; callers MAY branch only for their distinct responsibilities.
- Repeating the same discrimination and decision across callers is a major defect.
- Exhaustive caller-specific matching and a single stable local condition are excluded.
- Evidence MUST cite current discrimination and behavior-owner sites. Put the supplied variant and simulated edit placement in `reason`.

### PROBE-VENDOR-CHANGE — Apply required vendor difference
- Applies when substitutability is required or a neutral seam is claimed for a concrete external contract.
- The supplied API, error, or semantic difference SHOULD stop at the adapter and policy owner.
- Vendor types, codes, retry, or branches spreading into domain modules are a major defect.
- Evidence MUST cite current adapter and any leaked vendor-specific sites. Put the supplied vendor difference and simulated boundary placement in `reason`.

### PROBE-DOMAIN-SCENARIO — Add one domain scenario
- Applies when the probe supplies a concrete scenario and expected behavior.
- Behavior SHOULD enter the existing owner or a new owner with a clear invariant; callers SHOULD only invoke it.
- A new external helper or manager reconstructing owner policy is a major defect.
- True orchestration across peer owners and translating boundary handlers are excluded.
- Evidence MUST cite current scenario-owner and caller sites. Put the supplied scenario and simulated decision placement in `reason`.

# Test scenario design

## Applies when
- Primary sources are tests or a verdict relies on test design.
- A change claims observable behavior backed by supplied test sources.

## Not for
- Mere exploration without a behavior or readiness claim.
- Demanding tests without a named contract, risk, or plausible regression.

## Checks

### TEST-BOUNDARY — Stable behavior boundary
- Applies when a scenario supports a behavior verdict.
- Assertions MUST observe result, event, public error, visible state, or declared interaction at the nearest stable boundary.
- A public verdict based only on private state, call graph, or incidental layout is a major defect.
- A non-public unit is valid when it owns a named stable algorithm, parser, or policy contract and the verdict stays narrow.
- Evidence MUST show invocation, assertions, verdict scope, and relevant production interface.

### TEST-SCENARIO-LINEARITY — Linear scenario
- Applies to scenario tests or helpers controlling their flow.
- Setup, action, and observation SHOULD form one visible path; helpers SHOULD name domain operations without hiding later actions or assertions.
- Test branching, orchestration loops, catches, or algorithms obscuring one input/action/observation are minor defects.
- Table, property, and fuzz frameworks are excluded when each case has a stable oracle and replayable failure data.
- Evidence MUST show the full test and flow-relevant helpers.

### TEST-COLLABORATOR-CHOICE — Justified collaborator replacement
- Applies to one collaborator replaced by mock, fake, stub, or emulator.
- Replacement SHOULD address an uncontrolled external system, protocol boundary, unavailable resource, concrete cost, or nondeterminism.
- Replacing a fast local deterministic owned collaborator while reproducing internal choreography is a minor defect.
- Evidence MUST show the replacement, ownership, and concrete boundary/cost/nondeterminism facts.

### TEST-DOUBLE-CONTRACT — Double matches boundary contract
- Applies when one double's behavior supports the verdict.
- Configured responses, errors, and interactions MUST be allowed by the supplied boundary contract.
- A verdict depending on impossible or invented double behavior is a minor defect.
- A shared lightweight fake MAY qualify when separate allowed evidence establishes conformance.
- Evidence MUST show test configuration and the relevant response/error/interaction contract.

### TEST-PROTOCOL-ASSERTIONS — Interaction assertions reflect protocol
- Applies to exact order, call-count, or no-extra-interaction assertions.
- Exactness MUST be required by an observable protocol.
- Freezing private sequencing when alternative order/count preserves behavior is a minor defect.
- Counts MAY encode documented idempotency, exactly-once, cost limits, or duplicate-effect prevention.
- Evidence MUST show the assertion and the protocol requirement or complete absence of one in scope.

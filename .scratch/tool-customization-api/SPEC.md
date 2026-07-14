# Extension Tool Customization API Specification v0.1.0

## Overview

OMP extensions need a provider-independent way to customize an already constructed tool without copying its implementation or reconstructing `ToolSession`. The public surface adds two registration-time operations to `ExtensionAPI`:

- `patchTool` for metadata-only changes that preserve execution;
- `wrapTool` for an explicit decorator that may also replace or wrap execution.

The API applies to tools in the session's finalized initial registry: built-ins, extension tools, SDK custom tools, and startup MCP tools already present before the registry is bound to `AgentSession`.

## Design Principles

1. The live registry is the source of truth. Extensions never reconstruct a built-in tool to customize it.
2. `patchTool` preserves the selected tool's execution, state, schema, approval policy, activation state, and renderers unless a documented patch field changes them.
3. Customization is provider-independent and happens before the tool catalog is exposed to the model.
4. Composition order is deterministic: extension load order, then registration call order within each extension.
5. A customization failure cannot leave a partially modified tool. The previously valid tool remains registered and OMP emits an attributed extension diagnostic.
6. Tool names are immutable through customization. Registration under a new name remains the responsibility of `registerTool`.
7. Assumption: phase one targets the initial per-session registry. Tools discovered and inserted after session initialization are outside this contract.

## Scope

### In Scope

- `ExtensionAPI.patchTool(name, patch)` with `description` and `label` patch fields;
- `ExtensionAPI.wrapTool(name, decorator)` with a read-only live-tool view and a partial override result;
- preserving and delegating to the exact live tool implementation, including class-private state and method binding;
- deterministic composition of multiple patches/decorators;
- customization of the final registry winner when a registered extension/SDK tool has the same name as a built-in;
- diagnostics for missing targets, thrown decorators, invalid results, and attempted renames;
- application before `ExtensionToolWrapper`, so the final approval gate and tool lifecycle interception still cover the customized tool;
- extension documentation, contract tests, type checking, and coding-agent changelog.

### Out Of Scope

- configuration-file syntax for tool patches;
- mutation through `getAllTools()` or exposing the mutable registry;
- patching arbitrary provider request payloads;
- late/discovery-time MCP tools inserted after initial registry finalization;
- advisor tool pools built outside the primary session registry;
- changing active-tool selection as a side effect of patching;
- compatibility aliases for the new API;
- preserving a tool rename requested by a decorator.

## Public Interface

Conceptual TypeScript surface; implementation must reuse the repository's existing schema, tool, approval, renderer, and result types rather than introducing `any`.

```ts
interface ToolMetadataPatch {
    description?: string;
    label?: string;
}

interface ToolDecoratorPatch extends ToolMetadataPatch {
    parameters?: ToolParameters;
    strict?: boolean;
    approval?: ToolApproval;
    execute?: ToolExecute;
    renderCall?: ToolRenderCall;
    renderResult?: ToolRenderResult;
}

interface ReadonlyToolHandle {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: ToolParameters;
    readonly strict?: boolean;
    readonly approval?: ToolApproval;
    readonly execute: ToolExecute;
    readonly renderCall?: ToolRenderCall;
    readonly renderResult?: ToolRenderResult;
}

interface ExtensionAPI {
    patchTool(name: string, patch: ToolMetadataPatch): void;
    wrapTool(name: string, decorator: (original: ReadonlyToolHandle) => ToolDecoratorPatch): void;
}
```

`ReadonlyToolHandle.execute` and callback-valued properties are callable with their original receiver already preserved. An extension must not need `.bind(original)`.

Normative examples:

```ts
export default function customizeRead(pi: ExtensionAPI) {
    pi.patchTool('read', {
        description: 'Read files using the project-specific retrieval policy.'
    });
}
```

```ts
export default function auditRead(pi: ExtensionAPI) {
    pi.wrapTool('read', (original) => ({
        description: `${original.description}\nAlways prefer the narrowest useful range.`,
        async execute(toolCallId, params, signal, onUpdate) {
            audit(toolCallId, params);
            return original.execute(toolCallId, params, signal, onUpdate);
        }
    }));
}
```

## Data And State Model

### Tool customization registration

A registration records:

- target tool name;
- extension path/identity for diagnostics;
- registration sequence;
- either an immutable metadata patch or a decorator callback.

Registrations do not resolve targets during extension module loading because built-ins and other tool sources are not yet assembled.

### Base tool

For each name, the base tool is the final value in the registry after built-ins and registered extension/SDK tools have been inserted, but before customization is applied. Existing same-name registration semantics remain unchanged.

### Customized tool

Each successful registration transforms the previously valid tool for that name. The transformed tool retains all properties not explicitly overridden. The registry key and observable tool name remain the original target name.

## Behavior

### Metadata patching

**Inputs:** an exact tool name and a patch containing at least one supported field.

**Observable result:** the model-facing catalog and TUI use the patched metadata while calls still reach the original live execution implementation.

**Rules:**

- `description` changes only the description advertised to the model.
- `label` changes only the human-readable UI label.
- omitted fields retain their previous values.
- patching does not activate, deactivate, hide, rename, or replace execution.
- the caller-provided patch is snapshotted at registration; later mutation by extension code has no effect.

**Acceptance criteria:**

- AC-001: A `description` patch changes the description exposed by the initialized session for the named built-in tool.
- AC-002: After a metadata patch, executing the tool forwards the same call id, parsed arguments, abort signal, and update callback to the original live implementation and returns its exact observable result/error.
- AC-003: A `label` patch changes the rendered tool label without changing description or execution.
- AC-004: An empty metadata patch is accepted as a no-op and does not replace the tool.

### Tool decoration

**Inputs:** an exact tool name and a synchronous decorator returning a partial override.

**Observable result:** supplied fields override the current tool; omitted fields continue to use the current tool. An execution override may delegate through the bound `original.execute`.

**Rules:**

- the decorator runs once per session registry construction, not once per tool call;
- it receives the result of all earlier successful customizations for that tool;
- `original` is read-only and cannot mutate the live registry;
- callback properties on `original` preserve their correct receiver;
- `name` is not an overridable field;
- returned patches are validated before application;
- `execute` replacement remains inside the standard `ExtensionToolWrapper` approval and lifecycle boundary.

**Acceptance criteria:**

- AC-005: A decorator can wrap execution, observe the call, delegate to a stateful class-based built-in, and preserve its result.
- AC-006: A decorator can override description, parameters, strictness, approval, or renderer callbacks while omitted properties remain unchanged.
- AC-007: The final customized tool is still governed by extension `tool_call`/`tool_result` interception and the standard approval wrapper.

### Composition and precedence

**Rules:**

1. Build the base registry using current precedence: built-ins first, then same-name extension/SDK registrations.
2. Apply tool customizations in extension load order.
3. Within one extension, apply `patchTool` and `wrapTool` calls in source registration order.
4. Each customization sees the output of the preceding successful customization.
5. A later override of the same field wins.

**Acceptance criteria:**

- AC-008: Two customizations of one tool compose in deterministic registration order, and the later one sees the earlier description.
- AC-009: If `registerTool` replaces a built-in name, subsequent customization targets that final registered replacement rather than the discarded built-in.
- AC-010: Rebuilding or reloading a session reapplies registrations once to a fresh base registry and does not stack stale wrappers from the previous session.

### Invalid customization

**Rules:**

- A target absent from the finalized initial registry produces one attributed warning and leaves the registry unchanged.
- If a decorator throws, returns a non-object, supplies an invalid required field value, or attempts a rename, OMP emits one attributed error diagnostic and retains the previously valid tool.
- Failure of one customization does not prevent later customizations or unrelated tools from being processed.
- Diagnostics identify the extension source and target name without including untrusted unsanitized content in TUI output.

**Acceptance criteria:**

- AC-011: A missing target produces an attributed warning, does not create a tool, and does not abort session startup.
- AC-012: A throwing or invalid decorator produces an attributed error, retains the prior valid tool, and allows later registrations to run.
- AC-013: A decorator cannot rename the target or cause the registry key and tool name to diverge.

## Error Handling

Registration methods validate their immediate shape synchronously where possible. Target existence and decorator execution are resolved during registry finalization. Operational failures use the existing extension diagnostic/logger path; they do not become model-visible tool results because no tool call has occurred. The original or previously customized tool is the atomic fallback.

## Test Contract

`acceptance-ledger.yaml` contains concrete cases, implementation status, and traceability. Implementation is complete when every implementable case is `implemented` with executable proof.

Primary behavior seam: initialize a coding-agent session with a real extension registration and inspect/execute the resulting tool through the session/agent tool surface. Narrow unit tests may cover deterministic composition and fault isolation, but they cannot replace the session-level proof that the provider-visible definition and live execution use the same customized registry entry.

## Implementation Checklist

- [ ] Public types and `ExtensionAPI` methods implemented without `any` or `ReturnType<>`
- [ ] Registrations retained with extension attribution and stable order
- [ ] Initial registry customization phase implemented before `ExtensionToolWrapper`
- [ ] Bound original callbacks preserve class-private state
- [ ] Diagnostics sanitize extension and tool-derived content for TUI paths
- [ ] All implementable ledger cases are `implemented`
- [ ] Focused tests and `bun check` pass

## Version History

- **v0.1.0** — Initial contract for metadata patching and live-tool decoration.

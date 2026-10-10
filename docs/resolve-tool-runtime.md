# Resolution devices runtime

Pending previews do not use a `resolve` tool. They finalize through plain-text `write` calls to virtual `xd://` devices implemented in `packages/coding-agent/src/tools/resolve.ts`:

- `xd://resolve` — apply the pending staged preview; body = a one-sentence reason
- `xd://reject` — discard the pending staged preview; body = a one-sentence reason

These are internal URLs, not filesystem paths. `read xd://resolve` and `read xd://reject` return a one-line usage hint. Bodies are trimmed plain text, not JSON; the runtime does not enforce sentence count or a nonempty reason. Completed device writes carry `details.xdev` metadata; `writeDeviceDispatch()` exposes the envelope and `resolveDispatchDetails()` extracts apply/discard details from `xdev.inner`.

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason)` and optional `reject(reason)` callbacks. Each preview receives a unique pending-invoker ID in `ToolChoiceQueue`, so stacked previews do not overwrite one another.

When no hard tool-choice directive takes precedence, a pending preview makes `AgentSession.nextToolChoiceDirective()` return a soft requirement:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- reminder from `resolve-device-reminder.md`

The model complies by calling only writes to `xd://resolve` or `xd://reject` in that turn. A different write, another tool, or a resolution write batched with a detour is noncompliant: the calls are skipped and the next turn forces `write`. Repeated noncompliance eventually aborts rather than looping indefinitely.

Dispatch selects the in-flight queue invoker first, then the pending-preview head, and invokes its callback through `runResolveInvocation(...)`. `queueResolveHandler(...)` needs a session tool-choice queue; without one, it does not register a preview.

- A successful apply or discard consumes that pending invoker exactly once.
- If apply throws, the same preview is re-registered so the model can reject it or retry after fixing the cause.
- Rejecting with no pending action succeeds with `Nothing to reject; no pending action remains.`
- Resolving with no pending action throws.
- An apply callback's ordinary error becomes `ToolError("Apply failed: ...")`; an existing `ToolError` is preserved.

## Keeping `write` available

Because previews ride `write`, normal session assembly retains the transport:

- `createTools(...)` auto-appends `write` when a deferrable (preview-staging) tool is active and `restrictToolNames` is not set.
- `createAgentSession(...)` ensures registration for deferrable tools or deferred MCP discovery, subject to the same restriction.
- Active-tool reconciliation retains `write` while mounted devices or deferrable tools need it. This may be a device-only transport, not a general filesystem-write grant.

Low-level or restricted SDK hosts must explicitly supply the queue and write transport required by their preview flow.

## Custom tools

Custom tools still stage previews through `pushPendingAction(...)`; the loader forwards them into `queueResolveHandler(...)`. The custom-tool preview API is unchanged except for the model-facing finalization step: follow up with a plain-text write to `xd://resolve` or `xd://reject`, not a `resolve` tool call.

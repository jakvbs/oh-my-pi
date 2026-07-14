## What to build

Make MCP tool responses that contain only `structuredContent` visible to the coding agent instead of returning an empty tool result.

## Domain fit

Status: known
Context: `packages/coding-agent/src/mcp`, specifically the MCP protocol adapter and `MCPTool.execute` public test seam.
Existing sources: `packages/coding-agent/src/mcp/types.ts`, `packages/coding-agent/src/mcp/tool-bridge.ts`, MCP transport tests, and the `ttsc-graph` server contract that returns output-schema data through `structuredContent`.
Delta: Support the standard MCP structured result field at the existing adapter boundary.
Code mapping: `MCPToolCallResult` owns the wire shape; `MCPTool.execute` maps it into `CustomToolResult` consumed by the model.

## Acceptance criteria

- [x] A successful MCP response with empty `content` and a JSON `structuredContent` object reaches the model as serialized JSON text.
- [x] Existing text content remains the model-facing result when both text and structured content are present, avoiding duplicate payloads.
- [x] A real stdio MCP request carrying structured-only output crosses transport and `MCPTool` boundaries without becoming empty.

## Test seam

`MCPTool.execute`, exercised first with a controlled transport for RED/GREEN and then through a real stdio MCP server for end-to-end proof.

## Reviewability budget

Up to 150 effective LOC across the wire type, adapter behavior, focused regression coverage, and a deterministic stdio fixture. Decompose if the fix requires changing transport framing or manager lifecycle.

## Architecture notes

The MCP boundary owns protocol normalization. Preserve server-provided text when available; serialize `structuredContent` only as the fallback so clients do not receive the same payload twice.

## Out of scope

Rendering structured output as a dedicated TUI component, changing MCP servers, or preserving arbitrary unknown top-level response fields.

## Iteration log

### Iteration 2026-07-14 11:24 - structured result fallback - Plan

Goal: Prove and fix loss of MCP output-schema responses.
Acceptance: Structured-only results reach the model; text remains preferred; the stdio path works end to end.
Plan: Add a failing `MCPTool.execute` regression, implement fallback serialization at the adapter boundary, then exercise an actual stdio MCP response through the same public interface.
Budget: Up to 150 effective LOC; split transport work if it exceeds a deterministic fixture plus one integration scenario.
Verify: Focused Bun tests for the adapter and stdio scenario must report all cases passing; a direct ttsc-graph call through the fixed bridge must return non-empty JSON when locally available.

### Iteration 2026-07-14 11:49 - structured result fallback - Outcome

Change: Added the MCP wire field, model-facing JSON fallback, text precedence coverage, and a real stdio MCP fixture crossing initialization, tool discovery, invocation, and adapter mapping.
Tests: RED reproduced an empty string for structured-only output; GREEN passed 34 tests across `mcp-reconnect.test.ts` and `mcp-structured-content.test.ts`. Package type checking also passed.
Budget: The production change is localized to the result type and adapter; focused regression and stdio proof remain within the 150 effective LOC review budget.
Finding: The transport already preserved `structuredContent`; only `MCPTool` discarded it by formatting `content` exclusively.
Decision: Text content remains canonical when present. Structured output is pretty-printed only when formatted MCP content is empty.
Next: Stop; all acceptance criteria are implemented and automated.

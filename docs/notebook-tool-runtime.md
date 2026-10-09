# Notebook file runtime internals

This document describes current `.ipynb` handling in `coding-agent`.

The critical distinction: **notebook support is file conversion/editing, not notebook execution**. `.ipynb` files are exposed as editable cell-marked text through `read` and the edit pipeline; no notebook-specific tool starts or talks to a Python kernel.

## Implementation files

- [`crates/pi-edit/src/notebook.rs`](../crates/pi-edit/src/notebook.rs)
- [`crates/pi-edit/src/files.rs`](../crates/pi-edit/src/files.rs)
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts)

## 1) Runtime boundary: editing vs executing

## `.ipynb` file conversion (`crates/pi-edit/src/notebook.rs`)

- `read` treats `.ipynb` files as notebooks unless the selector is `:raw`.
- The default notebook view is editable text with markers:
  - `# %% [code] cell:N`
  - `# %% [markdown] cell:N`
  - `# %% [raw] cell:N`
- Line selectors and multi-range selectors operate on that virtual text.
- The edit pipeline round-trips virtual text back to notebook JSON through `serialize_edited_notebook_text(...)`.
- Existing notebook metadata is preserved when a marker references an existing unused `cell:N`; new cells get fresh empty metadata.
- A missing notebook passed to the serializer starts from an empty nbformat 4.5 notebook.
- The standalone `write` tool is not notebook-aware: it replaces the file content rather than converting cell markers. Use it only with valid notebook JSON, not the virtual marker representation.

No kernel lifecycle exists in this path:

- no kernel session ID
- no code execution
- no stream chunks from Python
- no rich display capture
- no output artifact pipeline from execution

## 2) Notebook cell handling semantics

## Source normalization

Notebook JSON `source` is converted to virtual text by joining source arrays. When virtual text is serialized back, cell source is split with newline preservation:

- each line ending in `\n` stays as a separate source entry with the newline
- a final non-newline-terminated line is stored without forcing a trailing newline
- empty content becomes an empty `source` array

This mirrors notebook JSON conventions and avoids accidental line concatenation on later edits.

### Marker-like source escaping

A source line that itself looks like a cell marker is escaped on render by adding one `%` (`# %% ...` becomes `# %%% ...`) and unescaped on parse. Already escaped marker-like lines gain and lose one additional `%` the same way. This prevents literal marker text inside a cell from being misparsed as a new cell during round-trip editing.

## Marker parsing and cell preservation

- A non-empty representation must start with a marker; text before the first marker, including a blank line, is rejected. Empty text serializes to a notebook with no cells.
- Markers must match `# %% [code|markdown|raw]` with optional `cell:N`.
- If `cell:N` points at an unused existing cell, that cell is cloned, its `cell_type` and `source` are updated, and unrelated fields are preserved.
- Existing code-cell `execution_count` and `outputs` are preserved rather than cleared, even when source changes; missing or null fields are initialized to `null` and `[]`. Editing therefore does not make stored outputs current.
- Markdown/raw cells remove `execution_count` and `outputs`.
- If no valid unused original index is present, a new cell with empty metadata is created.
- Notebook-level metadata, format fields, and unrelated top-level fields survive because serialization clones the original document and replaces only `cells`.

## Error surfaces

Hard failures are thrown for:

- missing notebook on read
- invalid JSON
- missing/non-array `cells`
- invalid cell objects or cell types
- invalid editable representation (for example, text before the first cell marker)

These surface through notebook-aware callers such as `read` and the edit pipeline as normal tool errors. The standalone `write` path does not parse notebook JSON.

## 3) Renderer assumptions and formatting

## Read/edit notebook representation

Notebook files are rendered to the model as text. The visible cell markers are part of the editable representation, not comments that are ignored during serialization.

The harness has no notebook execution path: cells are edited as text, never run.

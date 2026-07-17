---
name: dag-task-runner
description: Decompose a user task into a dependency DAG and execute it with OMP SDK sessions in topological ranks while rendering live status to a Cursor Canvas artifact. Use for fan-out, parallel subagents, or work naturally expressed as a dependency graph.
---

# DAG Task Runner

Author a JSON DAG, create its initial `.canvas.tsx` visualization, run every node through the OMP SDK runner, then summarize the result and relink the canvas. Parent outputs are stitched into child prompts. Live assistant text and task state are written into the canvas throughout execution.

The runner is available either from the oh-my-pi source example or from a generated standalone skill. A generated skill keeps runtime code under `runtime/`; run `bun install` there once. Set `DAG_RUNNER_DIR` to any runtime directory containing `index.ts` to override discovery.

## When to use

Use for requests such as:

- “decompose this task” or “break this into a DAG”;
- “fan out subagents” or “run this as a graph”;
- substantial work with independent research or post-implementation branches.

Skip single edits, quick questions, and work that is inherently linear.

## 1. Author the DAG

Schema:

```json
{
    "title": "<short run title>",
    "models": {
        "HIGH": "gpt-5.3-codex",
        "MED": "composer-2",
        "LOW": "auto-low"
    },
    "tasks": [
        {
            "id": "<unique-id>",
            "depends_on": ["<parent-id>"],
            "complexity": "HIGH",
            "subtask_prompt": "<self-contained task prompt>"
        }
    ]
}
```

Rules:

- Dependencies MUST reference task IDs in the same file. Cycles and self-dependencies are invalid.
- `complexity` MUST be `HIGH`, `MED`, or `LOW`.
- `models` is optional. Precedence is defaults < DAG `models` < `--models-file`.
- Prompts MUST be standalone. The runner prepends direct-parent results automatically.
- Same-rank tasks run concurrently. NEVER let siblings write the same file.

### Maximize useful width

1. Default to no dependency. Add one only when the child literally needs the parent's output.
2. Put independent read-only discovery in a wide first rank.
3. Put independent tests, docs, or checks after their shared implementation parent rather than chaining them.
4. Prefer diamonds over lines.
5. Serialize tasks that would edit the same file.

A nontrivial DAG SHOULD contain at least one rank with multiple tasks. The bundled `example-dag.json` demonstrates 2 → 1 → 1 → 2 ranks.

Write the DAG to a temporary JSON file such as `/tmp/dag-<slug>.json`.

## 2. Locate the runtime, install dependencies, and create the initial canvas

OMP discovers packaged project skills from `.omp/skills/` in the working directory and its ancestors. It discovers personal skills from the active agent directory: `~/.omp/agent/skills/` by default, `~/.omp/profiles/<profile>/agent/skills/` for a named profile, or `$PI_CODING_AGENT_DIR/skills/` when that override is set.

```bash
resolve_runner_dir() {
  if [ -n "${DAG_RUNNER_DIR:-}" ] && [ -f "$DAG_RUNNER_DIR/index.ts" ]; then
    printf '%s\n' "$DAG_RUNNER_DIR"
    return 0
  fi

  dir="$PWD"
  while :; do
    candidate="$dir/.omp/skills/dag-task-runner/runtime"
    if [ -f "$candidate/index.ts" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done

  if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    agent_dir="$PI_CODING_AGENT_DIR"
  else
    config_dir="${PI_CONFIG_DIR:-.omp}"
    if [ "${OMP_PROFILE+x}" = x ]; then
      profile="$OMP_PROFILE"
    else
      profile="${PI_PROFILE:-}"
    fi
    if [ -n "$profile" ] && [ "$profile" != "default" ]; then
      agent_dir="$HOME/$config_dir/profiles/$profile/agent"
    else
      agent_dir="$HOME/$config_dir/agent"
    fi
  fi

  git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  for candidate in \
    "$agent_dir/skills/dag-task-runner/runtime" \
    "${git_root:+$git_root/packages/coding-agent/examples/sdk/16-dag-task-runner}" \
    "$PWD/packages/coding-agent/examples/sdk/16-dag-task-runner"
  do
    if [ -n "$candidate" ] && [ -f "$candidate/index.ts" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "Could not find dag-task-runner; install the packaged skill or set DAG_RUNNER_DIR." >&2
  return 1
}

RUNNER_DIR="$(resolve_runner_dir)"
if [ -f "$RUNNER_DIR/package.json" ] && [ ! -d "$RUNNER_DIR/node_modules" ]; then
  (cd "$RUNNER_DIR" && bun install)
fi

CANVAS_PATH="$HOME/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx"

bun "$RUNNER_DIR/index.ts" \
  --init-only \
  --dag /tmp/dag-<slug>.json \
  --canvas-path "$CANVAS_PATH"
```

No live model credentials are required for `--init-only`. The workspace slug is the absolute cwd without a leading slash, with path separators and unsupported characters replaced by `-`.

Surface the exact absolute path before execution so the user can open it while tasks run:

> I created a live canvas: [Open Canvas](file:///absolute/path/to/dag-<slug>.canvas.tsx)
> Fallback path: `/absolute/path/to/dag-<slug>.canvas.tsx`

Use the link text `Open Canvas`. If the user keeps run artifacts in an Obsidian vault, `--canvas-path` MAY point into that vault and the fallback MAY also be expressed as `vault://<vault>/<path>`. OMP can read or link the file through its Obsidian integration; Cursor remains the renderer for the retained React Canvas artifact.

## 3. Run the DAG

Ensure normal OMP credentials are configured through `/login`, provider environment variables, or the OMP credential store, then use the same DAG and canvas paths:

```bash
bun "$RUNNER_DIR/index.ts" \
  --dag /tmp/dag-<slug>.json \
  --canvas-path "$CANVAS_PATH" \
  --cwd "$PWD"
```

The runner:

1. refreshes the OMP model registry and fails fast if no authenticated model exists;
2. validates the DAG and writes the initial all-`PENDING` canvas;
3. runs Kahn ranks sequentially and siblings concurrently;
4. streams assistant text into each running task card;
5. inspects terminal assistant messages so provider failures are not mistaken for success;
6. skips children of failed parents with an explicit upstream failure message;
7. records result text, duration, and available input/output token counts;
8. finalizes and flushes success, failure, timeout, and interrupted canvas states.

OMP automatic retries are disabled through isolated per-session settings. Legacy model labels remain visible in the canvas; `composer-2` routes through OMP `@default`, `auto-low` routes through `@smol`, and other values are passed as OMP model patterns. Every selection also carries an authenticated available-model fallback so a matching but unauthenticated provider cannot block execution when another configured model is usable.
SDK `agent_end` starts a 15-second post-stream finalization grace. Timed-out or late-created sessions are aborted/disposed through bounded best-effort cleanup so teardown cannot hide the task result.

### CLI controls

| Flag                            | Default           | Purpose                                   |
| ------------------------------- | ----------------- | ----------------------------------------- |
| `--models-file <path>`          | —                 | Partial complexity-to-model override map. |
| `--task-timeout-ms <ms>`        | `1200000`         | Overall task deadline.                    |
| `--stream-publish-ms <ms>`      | `500`             | Live canvas publish throttle.             |
| `--stream-idle-timeout-ms <ms>` | `300000`          | No-session-event timeout.                 |
| `--debounce <ms>`               | `200`             | Canvas write debounce.                    |
| `--cwd <path>`                  | current directory | SDK session working directory.            |

All numeric controls require positive safe integers.

## 4. Summarize

After exit:

- name completed and failed tasks;
- mention skipped descendants and their failed parents;
- mention timeout or interruption details when present;
- relink `[Open Canvas](file:///absolute/path/to/dag-<slug>.canvas.tsx)`.

## Limits and safety

- Siblings share a filesystem and MUST NOT edit the same file concurrently.
- Each parent contributes at most 2,000 characters to a child prompt.
- Each task card retains the newest 4,000 streamed characters.
- A direct parent in `ERROR` prevents the child from launching; this cascades.
- SIGINT, SIGTERM, and SIGHUP mark nonterminal tasks and flush the canvas before exit.
- The generated `.canvas.tsx` uses `cursor/canvas`; Obsidian can store/address it but does not render it.

## Reference

- Runner: `index.ts` in `$RUNNER_DIR`
- DAG example: `example-dag.json` in the source `$RUNNER_DIR`, or `../examples/example-dag.json` beside a packaged runtime
- Static task prompt: `prompts/task.md` in `$RUNNER_DIR`
- SDK documentation: `https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md`

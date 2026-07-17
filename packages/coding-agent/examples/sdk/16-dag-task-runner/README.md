# DAG Task Runner

A 1:1 SDK migration of the Cookbook DAG runner. It parses a JSON dependency graph, runs ready tasks concurrently with `@oh-my-pi/pi-coding-agent`, stitches parent results into child prompts, and repeatedly rewrites a self-contained Cursor Canvas visualization.

The visualization remains `.canvas.tsx` rather than being reduced to Markdown or an incompatible Obsidian Canvas JSON shape. That preserves the original graph, cards, status styling, streamed output, scroll restoration, and node navigation. The file can live inside an Obsidian vault and be addressed through OMP's optional `vault://` integration, but rendering the React canvas still requires a Cursor Canvas host.

## Behavior

- Validates IDs, dependencies, complexity values, model overrides, and cycles.
- Uses source-order Kahn ranks. Ranks run sequentially; siblings run concurrently.
- Prepends up to 2,000 characters from each direct parent's result to a child prompt.
- Keeps the newest 4,000 streamed assistant characters per task and publishes at most every 500 ms by default.
- Marks provider failures recorded in the terminal OMP assistant message as task errors even when `session.prompt()` resolves.
- Disables OMP automatic retries to retain the original runner's no-task-retry behavior.
- Marks dependents of failed tasks as `ERROR` without launching them.
- Flushes initial, terminal, failed, and interrupted canvas states.

## Run from the monorepo

Install the workspace once from the repository root:

```bash
bun install
```

Then render the initial all-`PENDING` canvas without model credentials:

```bash
cd packages/coding-agent/examples/sdk/16-dag-task-runner
bun run init-canvas
```

The generated file is `.canvas/dag-example.canvas.tsx`. Run the six-task example after configuring at least one model through OMP (`/login`, provider environment variables, or the normal OMP credential store):

```bash
bun run example
```

Tasks operate in `--cwd`, which defaults to the directory where the command is invoked. Use a scratch directory for the example's generated `todo.mjs`, tests, and README:

```bash
EXAMPLE="$PWD/packages/coding-agent/examples/sdk/16-dag-task-runner"
mkdir -p /tmp/omp-dag-demo
cd /tmp/omp-dag-demo
bun "$EXAMPLE/index.ts" \
  --dag "$EXAMPLE/example-dag.json" \
  --canvas-path "$PWD/dag-example.canvas.tsx" \
  --cwd "$PWD"
```

Expected scheduling shape:

```text
[dag-runner] DAG "Build a tiny CLI todo app" — 6 tasks across 4 rank(s)
[dag-runner] rank 1/4: research-stack, research-cli-conventions
[dag-runner] rank 2/4: design
[dag-runner] rank 3/4: implement
[dag-runner] rank 4/4: tests, docs
```

## DAG schema

```json
{
    "title": "Build a tiny CLI todo app",
    "models": {
        "HIGH": "gpt-5.3-codex",
        "MED": "composer-2",
        "LOW": "auto-low"
    },
    "tasks": [
        {
            "id": "research-stack",
            "depends_on": [],
            "complexity": "LOW",
            "subtask_prompt": "Sketch the smallest reasonable design …"
        }
    ]
}
```

| Field            | Required | Contract                                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------------------- |
| `title`          | yes      | Nonblank string. Validation trims only for the blank check; stored text is unchanged. |
| `id`             | yes      | Unique nonblank task ID.                                                              |
| `depends_on`     | no       | String IDs; defaults to `[]`; duplicates are removed in insertion order.              |
| `complexity`     | yes      | Exactly `HIGH`, `MED`, or `LOW`.                                                      |
| `subtask_prompt` | yes      | Nonblank standalone prompt. Stored text is unchanged.                                 |
| `models`         | no       | Partial complexity-to-model selector map. Values are trimmed.                         |

Unknown IDs, self-dependencies, duplicate task IDs, and cycles fail before execution. See [`example-dag.json`](./example-dag.json) for the complete 2 → 1 → 1 → 2 example.

## Model routing

The observable model map and canvas labels stay identical to the source runner:

| Complexity | Legacy/default selector | OMP SDK adapter                         |
| ---------- | ----------------------- | --------------------------------------- |
| `HIGH`     | `gpt-5.3-codex`         | Passed as an OMP `modelPattern`.        |
| `MED`      | `composer-2`            | Resolved through OMP's `@default` role. |
| `LOW`      | `auto-low`              | Resolved through OMP's `@smol` role.    |

DAG overrides and `--models-file` values are passed directly as OMP model patterns. Precedence is defaults < DAG `models` < `--models-file`. Use selectors available to your OMP installation. The runner awaits model-registry refresh and fails before DAG parsing when normal execution has no authenticated models.

OMP retry is explicitly disabled for every task session. A provider error or abort in the terminal assistant message becomes `ERROR`; successful terminal messages become `FINISHED`.

## CLI

| Flag                       | Default                 | Notes                                                                       |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `--dag`                    | required                | DAG JSON path.                                                              |
| `--canvas-path`            | composed                | Preferred full canvas path. `.canvas.tsx` is normalized.                    |
| `--canvas`                 | —                       | Canvas stem when `--canvas-path` is omitted.                                |
| `--canvases-dir`           | retained workspace path | Used with `--canvas`; defaults to `~/.cursor/projects/<cwd-slug>/canvases`. |
| `--cwd`                    | `process.cwd()`         | Working directory for every task session.                                   |
| `--models-file`            | —                       | Partial complexity-to-model JSON override.                                  |
| `--init-only`              | `false`                 | Write the initial canvas and exit without auth.                             |
| `--debounce`               | `200` ms                | Serialized visualization write debounce.                                    |
| `--task-timeout-ms`        | `1200000`               | Overall task deadline.                                                      |
| `--stream-publish-ms`      | `500` ms                | Live output publish throttle.                                               |
| `--stream-idle-timeout-ms` | `300000` ms             | No-session-event timeout, bounded by the task deadline.                     |

Unknown flags are ignored, matching the original CLI. Numeric flags accept positive safe integers only.

## Prompt and failure semantics

Dependent tasks receive this static Handlebars template:

```text
Upstream task results (for context — do not re-do this work):

### <parent-id> [<status>]
<result, failure marker, or no-output marker>

---

<original subtask prompt>
```

Each direct parent snippet is capped at 2,000 characters with a final ellipsis. If any direct dependency is `ERROR`, the task is not launched and receives `Skipped: upstream task(s) … failed`; this naturally cascades through later ranks.

A 20-minute deadline covers SDK session creation and the agent turn. Session events reset the five-minute idle timer. Timeouts abort best-effort. All sessions are in-memory and disposed after the task. The canvas writer serializes writes and flushes the latest snapshot, including on SIGINT, SIGTERM, SIGHUP, and runner failures.

## Canvas and Obsidian

The generated artifact is the original self-contained React + `cursor/canvas` source with inlined `RunState`. It includes:

- DAG edges and theme-aware task nodes;
- task prompts, models, durations, token counts, streamed/final results, and errors;
- run counts, outcome, elapsed time, and total tokens;
- graph-node navigation to expandable task cards;
- scroll restoration across hot reloads.

To keep the artifact in an Obsidian vault, provide an absolute vault path:

```bash
bun index.ts --init-only \
  --dag example-dag.json \
  --canvas-path "/path/to/vault/runs/dag-example.canvas.tsx"
```

OMP can then read or link it through `vault://<vault>/runs/dag-example.canvas.tsx` when Obsidian integration is enabled. Obsidian does not execute `cursor/canvas` React files; use Cursor to render the live canvas.

## Skill

[`skill/SKILL.md`](./skill/SKILL.md) contains the copyable workflow prompt adapted to this monorepo. It locates this example through `DAG_RUNNER_DIR` or the repository path and uses Bun directly; it does not install a second dependency tree or copy lock/workspace files.

## Files

```text
16-dag-task-runner/
├── README.md
├── package.json
├── tsconfig.json
├── index.ts
├── dag.ts
├── canvas-writer.ts
├── index.test.ts
├── example-dag.json
├── prompts/task.md
└── skill/SKILL.md
```

The source GIF is intentionally not copied: it is a 2.6 MB Cursor recording and is unnecessary for a runnable monorepo example. SDK details are documented in [`../../../../../docs/sdk.md`](../../../../../docs/sdk.md).

# DAG Task Runner

An SDK migration of the Cookbook DAG runner. It parses a JSON dependency graph, starts each task as soon as its own dependencies finish, injects only explicitly selected parent results into child prompts, and repeatedly rewrites a self-contained Cursor Canvas visualization.

The visualization remains `.canvas.tsx` rather than being reduced to Markdown or an incompatible Obsidian Canvas JSON shape. That preserves the original graph, cards, status styling, streamed output, scroll restoration, and node navigation. The file can live inside an Obsidian vault and be addressed through OMP's optional `vault://` integration, but rendering the React canvas still requires a Cursor Canvas host.

## Behavior

- Runs mandatory deterministic preflight first: goal, success criteria, IDs, dependencies, context sources, declared writes, complexity values, model overrides, and cycles. Independent errors are reported together.
- Optionally runs one isolated semantic LLM review (`--semantic-preflight` / `--review-only`) against the exact normalized effective DAG before any canvas write or task session.
- Uses deterministic source-order readiness. Root tasks start together; each dependent starts as soon as all of its own parents finish.
- Prepends up to 2,000 characters from each task named in `context_from`; ordering-only dependencies add no prompt context.
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

The generated file is `.canvas/dag-example.canvas.tsx`. Live execution requires at least one model configured through OMP (`/login`, provider environment variables, or the normal OMP credential store) and an explicit existing scratch directory. The package script refuses to run without `--cwd`, so it cannot overwrite this example's README or create demo files in the source tree:

```bash
mkdir -p /tmp/omp-dag-demo
bun run example -- --cwd /tmp/omp-dag-demo
```

The direct CLI preserves the source runner's optional `--cwd` behavior. When running the destructive six-task demo directly, pass a scratch directory:

```bash
EXAMPLE="$PWD/packages/coding-agent/examples/sdk/16-dag-task-runner"
mkdir -p /tmp/omp-dag-demo
bun "$EXAMPLE/index.ts" \
  --dag "$EXAMPLE/example-dag.json" \
  --canvas-path "/tmp/omp-dag-demo/dag-example.canvas.tsx" \
  --cwd /tmp/omp-dag-demo
```

Expected scheduling shape:

```text
[dag-runner] DAG "Build a tiny CLI todo app" — 6 tasks across 4 rank(s)
[dag-runner] starting research-stack
[dag-runner] starting research-cli-conventions
[dag-runner] starting design
[dag-runner] starting implement
[dag-runner] starting tests
[dag-runner] starting docs
```

## DAG schema

```json
{
    "title": "Build a tiny CLI todo app",
    "goal": "Build a tiny single-file Node.js CLI todo app with local JSON persistence, tests, and a short README.",
    "success_criteria": [
        "A single-file `todo.mjs` supports add, list, done, and rm against a local JSON store.",
        "`test_todo.mjs` exercises the core command flow with Node's built-in test runner.",
        "README.md documents commands, examples, and storage location without modifying todo.mjs."
    ],
    "models": {
        "HIGH": "gpt-5.3-codex",
        "MED": "composer-2",
        "LOW": "auto-low"
    },
    "tasks": [
        {
            "id": "research-stack",
            "depends_on": [],
            "context_from": [],
            "writes": [],
            "complexity": "LOW",
            "subtask_prompt": "Sketch the smallest reasonable design …"
        }
    ]
}
```

| Field               | Required | Contract                                                                                                      |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `title`             | yes      | Display label. Nonblank string. Validation trims only for the blank check; stored text is unchanged.          |
| `goal`              | yes      | Nonblank string. Validation trims only for the blank check; stored text is unchanged.                         |
| `success_criteria`  | yes      | Nonempty string array. Blank entries are rejected; exact duplicates are removed in insertion order.           |
| `id`                | yes      | Unique nonblank task ID.                                                                                      |
| `depends_on`     | no       | Scheduling and failure-propagation IDs; defaults to `[]`; duplicates are removed in insertion order.         |
| `context_from`   | yes      | IDs whose results enter the prompt; must be a subset of `depends_on`; duplicates are removed.                |
| `writes`         | yes      | Exact normalized repo-relative paths, `[]` for no repo writes, or `["*"]` for an unbounded write scope.      |
| `complexity`     | yes      | Exactly `HIGH`, `MED`, or `LOW`.                                                                              |
| `subtask_prompt` | yes      | Nonblank standalone prompt. Stored text is unchanged.                                                         |
| `models`         | no       | Partial complexity-to-model selector map. Values are trimmed.                                                 |

Unknown IDs, self-dependencies, duplicate task IDs, cycles, context sources outside `depends_on`, unsafe write paths, and unordered overlapping writes fail before execution. See [`example-dag.json`](./example-dag.json) for the complete 2 → 1 → 1 → 2 example.

## Model routing

The observable model map and canvas labels stay identical to the source runner:

| Complexity | Legacy/default selector | OMP SDK adapter                         |
| ---------- | ----------------------- | --------------------------------------- |
| `HIGH`     | `gpt-5.3-codex`         | Passed as an OMP `modelPattern`.        |
| `MED`      | `composer-2`            | Resolved through OMP's `@default` role. |
| `LOW`      | `auto-low`              | Resolved through OMP's `@smol` role.    |

DAG overrides and `--models-file` values are passed as OMP model patterns. Precedence is defaults < DAG `models` < `--models-file`. The runner awaits model-registry refresh and requires at least one authenticated model. Every requested pattern also receives that authenticated model as the SDK's auth-safe fallback, so an unauthenticated exact provider match cannot defeat otherwise valid configured credentials. The canvas continues to show the retained complexity label.

OMP retry is explicitly disabled in isolated per-session settings. A provider error or abort in the terminal assistant message becomes `ERROR`; successful terminal messages become `FINISHED`.

## CLI

| Flag                       | Default                 | Notes                                                                       |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `--dag`                    | required                | DAG JSON path.                                                              |
| `--canvas-path`            | composed                | Preferred full canvas path. `.canvas.tsx` is normalized.                    |
| `--canvas`                 | —                       | Canvas stem when `--canvas-path` is omitted.                                |
| `--canvases-dir`           | retained workspace path | Used with `--canvas`; defaults to `~/.cursor/projects/<cwd-slug>/canvases`. |
| `--cwd`                    | `process.cwd()`         | Working directory for every task session.                                   |
| `--models-file`            | —                       | Partial complexity-to-model JSON override.                                  |
| `--init-only`              | `false`                 | Write the initial canvas and exit without task sessions.                    |
| `--semantic-preflight`     | `false`                 | Run one isolated semantic review; execute only on pass.                     |
| `--review-only`            | `false`                 | Implies semantic review; no task sessions or canvas required.               |
| `--review-model`           | `@default`              | Reviewer model pattern; requires semantic/review-only mode.                 |
| `--review-timeout-ms`      | `120000`                | Reviewer deadline; requires semantic/review-only mode.                      |
| `--debounce`               | `200` ms                | Serialized visualization write debounce.                                    |
| `--task-timeout-ms`        | `1200000`               | Overall task deadline.                                                      |
| `--stream-publish-ms`      | `500` ms                | Live output publish throttle.                                               |
| `--stream-idle-timeout-ms` | `300000` ms             | No-session-event timeout, bounded by the task deadline.                     |

Unknown flags are ignored, matching the original CLI. Numeric flags accept positive safe integers only.

## Preflight layers

1. **Deterministic validation** always runs before model/session/canvas creation. It collects every independent schema/graph error (no prompt-quality lints).
2. **Semantic review** is opt-in. Sequence:

```text
read JSON
→ deterministic validation
→ merge model overrides
→ hash normalized effective DAG (SHA-256)
→ optional semantic review
→ execute the same in-memory DAG object
```

Semantic review is tool-free, structured, bounded, and cannot mutate repository state. It can warn or request revision, but it never auto-rewrites the DAG. Review cost and verdicts are non-deterministic model outputs; warnings alone still pass, while any `severity: "error"` issue forces `revise` and blocks canvas/task creation. The reviewer sees only the supplied goal/criteria/DAG JSON — no repository tools.

## Prompt and failure semantics

Tasks with non-empty `context_from` receive this static Handlebars template:

```text
Upstream task results (for context — do not re-do this work):

### <parent-id> [<status>]
<result, failure marker, or no-output marker>

---

<original subtask prompt>
```

Each selected context snippet is capped at 2,000 characters with a final ellipsis. If any direct dependency is `ERROR`, the task is not launched and receives `Skipped: upstream task(s) … failed`; this naturally cascades through downstream tasks.

A 20-minute deadline covers SDK session creation and the agent turn. Session events reset the five-minute idle timer; SDK `agent_end` starts the retained 15-second post-stream finalization grace, bounded by the remaining task deadline. Timeouts abort best-effort. Abort and dispose operations are individually bounded so cleanup cannot mask the recorded result, and a session factory that resolves after its deadline is observed and cleaned up. All sessions are in-memory. The canvas writer serializes writes and flushes the latest snapshot, including on SIGINT, SIGTERM, SIGHUP, and runner failures.

## Canvas and Obsidian

The generated artifact is the original self-contained React + `cursor/canvas` source with inlined `RunState`. It includes:

- solid context-carrying edges, dashed ordering-only edges, and theme-aware task nodes;
- task prompts, models, declared writes, durations, token counts, streamed/final results, and errors;
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

## Package or install the skill

Generate a self-contained skill at an explicit destination whose final directory name is `dag-task-runner`:

```bash
bun run package-skill -- /tmp/omp-skills/dag-task-runner
cd /tmp/omp-skills/dag-task-runner/runtime
bun install
bun run check
bun run init-canvas
```

The packager copies the hand-owned runtime sources and static prompt; it does not maintain a second source tree. A generated ownership marker permits later syncs to replace only output from this packager. Existing unmarked destinations are refused and never deleted.

OMP's native discovery scans `<ancestor>/.omp/skills/` for project skills and the active agent directory's `skills/` for personal skills. Standard install commands are:

```bash
# Project or repository scope
bun run package-skill -- "$PWD/.omp/skills/dag-task-runner"
(cd "$PWD/.omp/skills/dag-task-runner/runtime" && bun install)

# Default personal scope
bun run package-skill -- "$HOME/.omp/agent/skills/dag-task-runner"
(cd "$HOME/.omp/agent/skills/dag-task-runner/runtime" && bun install)

# Named OMP profile
bun run package-skill -- "$HOME/.omp/profiles/<profile>/agent/skills/dag-task-runner"
(cd "$HOME/.omp/profiles/<profile>/agent/skills/dag-task-runner/runtime" && bun install)
```

`PI_CODING_AGENT_DIR` overrides the personal agent directory, and `PI_CONFIG_DIR` changes the default `.omp` personal config root. Set `DAG_RUNNER_DIR` to the generated `runtime/` for a nonstandard explicit destination. [`skill/SKILL.md`](./skill/SKILL.md) resolves repo-local and standard packaged locations and performs a missing `runtime/node_modules` setup before use.

Generated layout:

```text
dag-task-runner/
├── .dag-task-runner.generated.json
├── .gitignore
├── SKILL.md
├── examples/
│   └── example-dag.json
└── runtime/
    ├── package.json
    ├── tsconfig.json
    ├── text-imports.d.ts
    ├── index.ts
    ├── dag.ts
    ├── run-example.ts
    ├── canvas-writer.ts
    ├── preflight.ts
    └── prompts/
        ├── task.md
        ├── preflight-system.md
        └── preflight-review.md
```

The generated runtime keeps the safe demo contract: `bun run example` still requires `--cwd <existing-scratch-directory>`.

## Files

```text
16-dag-task-runner/
├── .gitignore
├── README.md
├── package.json
├── tsconfig.json
├── package-skill.ts
├── index.ts
├── dag.ts
├── preflight.ts
├── run-example.ts
├── canvas-writer.ts
├── index.test.ts
├── preflight.test.ts
├── package-skill.test.ts
├── example-dag.json
├── prompts/task.md
├── prompts/preflight-system.md
├── prompts/preflight-review.md
└── skill/SKILL.md
```

The source GIF is intentionally not copied: it is a 2.6 MB Cursor recording and is unnecessary for a runnable monorepo example. SDK details are documented in [`../../../../../docs/sdk.md`](../../../../../docs/sdk.md).

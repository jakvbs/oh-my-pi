# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `omp`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@oh-my-pi/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `python/robomp` — self-hosted GitHub triage and fix service

Sources: [`python/robomp/README.md`](../python/robomp/README.md), [`python/robomp/pyproject.toml`](../python/robomp/pyproject.toml), [`python/robomp/.env.example`](../python/robomp/.env.example), [`python/robomp/docker-compose.yml`](../python/robomp/docker-compose.yml).

- Python package: `robomp` (Python 3.11 or newer); bin: `robomp`, with `serve`, `triage`, `replay`, `status`, and `cleanup` commands.
- Feature: self-hosted service that receives GitHub webhooks for allowlisted repositories, classifies issues, resumes an `omp --mode rpc` session per issue, comments or opens a fix PR, and handles follow-up issue and PR conversations. Incoming PR review is enabled by default; the opt-in release sentinel handles failed release CI (`ROBOMP_RELEASE_SENTINEL_ENABLED`, default false).
- Dashboard/API: FastAPI serves the operator dashboard at `/` alongside health, event, issue, and replay endpoints. The bundled Compose deployment publishes it at `http://localhost:6543/`; `bun run robomp:web:dev` runs the dashboard frontend in development, and `bun run robomp:web:build` rebuilds its static bundle.
- Inputs/storage: Compose interpolates `python/robomp/.env` through explicit per-service environment allowlists and mounts `~/.omp/agent/models.container.yml` as agent `models.yml`. Host CLI configuration uses process environment and `.env` relative to cwd. GitHub webhook events feed a SQLite-backed queue; Compose persists the database, workspaces, session transcripts, and logs in the `robomp_data` volume under `/data`.
- Root commands: `bun run robomp:install` installs the Python package for host development; `bun run robomp:serve` runs it on the host; `bun run robomp:build`/`bun run robomp:rebuild`, `bun run robomp:up`, `bun run robomp:down`, `bun run robomp:restart`, `bun run robomp:logs`, `bun run robomp:dev`, and `bun run robomp:reset` manage the container deployment.
- Prerequisites: Docker Compose v2 for the bundled deployment, a host-reachable model gateway matching the container model configuration, a GitHub webhook endpoint, and a bot PAT with write access to every allowlisted repository. The orchestrator requires an HMAC-authenticated `gh-proxy` and refuses to hold `GITHUB_TOKEN`; the bundled two-container deployment passes the PAT only to the sidecar. Host development must likewise keep the PAT out of the orchestrator environment and `.env`.

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@oh-my-pi/omp-stats`; bin: `omp-stats`; main user path: `omp stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `omp stats` starts or reuses the dashboard at `http://127.0.0.1:3847`, opens it in the browser, and keeps running. `--port <port>` changes the port; `--host <host>` changes the bind address (loopback by default). `--summary` prints a console summary; `--json` prints JSON and exits. The standalone `omp-stats` uses `--sync` for its summary mode and does not automatically open a browser.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: scans the active profile's session directory recursively, including nested subagent transcripts; stores aggregates in that profile's stats database. Default paths are `~/.omp/agent/sessions/` and `~/.omp/stats.db`; initialized XDG data roots and named profiles change them through the shared directory resolver.
- Outputs: request/token/cost, provider, model, folder, tool, gain, and frustration dashboards. API endpoints include `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, `/api/stats/tools`, `/api/stats/gain`, `/api/status`, `/api/events` (SSE), and `/api/sync` (POST).
- Side effects/limits: one-shot reports finish ingestion and rollups before printing. The dashboard binds immediately and starts background ingestion when a page connects to its event stream; `Ctrl+C` closes the CLI's stats database and exits. Frustration judging in `omp stats` lazily uses the configured `judge` role (telemetry purpose `stats_frustration`) and can make model calls; standalone `omp-stats` does not supply a judge.

### `packages/omptype` — schema validation library

Sources: [`packages/omptype/README.md`](../packages/omptype/README.md), [`packages/omptype/package.json`](../packages/omptype/package.json), and the repository [omptype authoring guide](./omptype-guide.md).

- Package: public `@oh-my-pi/omptype`; install with `bun add @oh-my-pi/omptype`. Its manifest declares Node 20 or newer and Bun 1.3.14 or newer.
- Feature: callable ArkType-compatible schemas with cheap interpreted startup, lazy hot-path compilation, validation errors, defaults and morphs, and JSON Schema emission.
- Public surfaces: `@oh-my-pi/omptype` for native authoring, `/typebox` and `/zod` for compatibility builders, and `/ark` for the alias-free ArkType compatibility facade.
- Runtime behavior: schema calls return the validated value or `type.errors`; `.assert()` returns the value or throws; `.allows()` performs a boolean check.
- Limits: this is an intentionally focused compatibility surface rather than a complete implementation of every ArkType, TypeBox, or Zod API.

### `packages/browser-relay` — drive existing Chrome tabs

Sources: [`packages/browser-relay/README.md`](../packages/browser-relay/README.md), [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- Package: private `@oh-my-pi/browser-relay`; user command: `omp browser-relay`.
- Setup: run `omp browser-relay install`, load the unpacked extension from
  `~/.omp/browser-relay/extension`, then opt in per call with `app.relay: true` — or set
  `browser.relay`, which makes the relay the profile-wide default across projects (scope
  details in the package README).
- Behavior: the relay auto-starts through the profile-independent global daemon broker; consumers
  across projects hold leases, and the relay stops after the last lease is released. `app.target`
  selects a tab by URL/title substring, otherwise the visible tab is adopted. Supplying a URL
  navigates that adopted tab. `omp browser-relay --no-group` disables automatic tab grouping.
- Security/limits: it binds loopback; use `--token` when local processes are untrusted. Chrome
  internal pages, DevTools, Web Store, extension pages, and tabs with DevTools open cannot attach.

### `packages/collab-web` — browser client for collaborative sessions

Sources: [`packages/collab-web/README.md`](../packages/collab-web/README.md), [`packages/collab-web/package.json`](../packages/collab-web/package.json), [`docs/collab.md`](./collab.md).

- Package: private `@oh-my-pi/collab-web`; production client: <https://my.omp.sh/>.
- Feature: browser guest UI for `/collab` sessions, including streaming transcript, tool cards,
  subagent views, prompts, and host interruption.
- Local paths: `bun run dev` serves the UI on port 3000; `bun run mock-host` runs an offline relay
  and scripted host; `bun run build` emits a static SPA under `dist/`.
- Constraints: non-local deployments require HTTPS and a reachable secure WebSocket relay. The room
  key stays in the URL fragment and is not sent to the relay.

### `packages/snapcompact` — bitmap context-compression API

Sources: [`packages/snapcompact/README.md`](../packages/snapcompact/README.md), [`packages/snapcompact/package.json`](../packages/snapcompact/package.json), [`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts).

- Package: public `@oh-my-pi/snapcompact`; install with `bun add @oh-my-pi/snapcompact`; requires
  Bun 1.3.14 or newer.
- Feature: deterministic local serialization and PNG rendering of discarded conversation history
  for vision-model context compaction; no model call or API key is required.
- Public entrypoint includes `compact`, `render`, `renderMany`, `frames`, shape selection, text
  normalization/serialization, image budgets, and file-operation helpers.
- Runtime constraint: rasterization and PNG encoding require `@oh-my-pi/pi-natives`.

### `packages/mnemopi` — standalone local-memory CLI

Sources: [`packages/mnemopi/README.md`](../packages/mnemopi/README.md), [`packages/mnemopi/package.json`](../packages/mnemopi/package.json), [`packages/mnemopi/src/cli.ts`](../packages/mnemopi/src/cli.ts), and the coding-agent [Mnemopi memory backend guide](./mnemosyne-memory-backend.md).

- Package: public `@oh-my-pi/pi-mnemopi`; bin: `mnemopi`; requires Bun 1.3.14 or newer. Install globally with `bun add --global @oh-my-pi/pi-mnemopi`, then run `mnemopi <command>`. From a source checkout, `bun packages/mnemopi/src/cli.ts <command>` runs the same entrypoint.
- Store and search: `store`/`remember`, `recall`/`search`, `update`/`edit`, and `delete`/`forget`.
- Inspect and maintain: `stats`, `sleep`/`consolidate`, `diagnose`/`doctor`, JSON `export` and `import`, `scratchpad`/`sp` with `read`, `write`, or `clear`, and `bank` with `list`, `create`, or `delete`.
- Storage: standalone commands use `~/.hermes/mnemopi/data/mnemopi.db` by default; `MNEMOPI_DATA_DIR` selects a different data directory. This default is separate from OMP's session-managed memory location.
- Integration: `mcp` starts the package's MCP server. The standalone CLI operates directly on Mnemopi storage; select `memory.backend: mnemopi` instead when integrating memory into OMP sessions, as described in the backend guide.
- Discovery and errors: `mnemopi --help` lists primary command forms. Unknown commands and invalid arguments print a concise error and return a nonzero exit code.

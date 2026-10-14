# wait

> Block until the next background job result, a new error line or a stall in a running bash job's output, a service exit, or a steering interrupt when there is no other work to do.

## Source
- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability
`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs or supervised services are enabled; it does not select a particular job.

## Behavior
- Returns on the first settled caller-owned job or owned-service exit. Job results delivered by this call are consumed so no duplicate async-result follows.
- A running bash job wakes the wait when its output gains a line shaped like a failure (`error:`, `error[E…]:`, `error TS…:`, `FAIL`/`FAILED`, `(fail)`, `panicked at`, a Python traceback, `npm ERR!`, `##[error]`, `Segmentation fault`). Each distinct error line wakes once per job: a status watcher that reprints the same table every interval (`gh run watch` off a terminal) does not wake again for a line it repeats. Owner: `packages/coding-agent/src/async/output-alert.ts`.
- Silence wakes the wait only as evidence of a stall: the job's output must have changed at least twice while watched, and the silence must last 5 minutes and three times the job's longest gap between changes. A job silent by design (output redirected to `/dev/null`, a quiet build step) never stall-wakes; neither does a watcher that keeps redrawing. Each silent stretch wakes once and re-arms after new output.
- An output alert leads the result with an `## Output alert` section quoting the triggering lines, followed by the jobs snapshot; the job keeps running.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- An owned-job or owned-service wait has a 30-minute safety cap. There is no caller-selectable timeout. Hitting the cap returns a result that starts with `## Wait limit reached`, states how long each running job has run and whether its output changed recently or ever, and then lists the jobs snapshot, so it never reads like a wait that returned at once.
- If no owned job or service is running, the call fails with `Nothing to wait for`.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Already-settled but undelivered owned jobs are returned without another wait.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- Bare `read history://` lists session transcripts.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.

Persistent shell: one fact command/pipeline; dependencies use `&&`.
Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results and has no deadline unless `timeout` is set; foreground default {{defaultTimeoutSec}}s, `timeout: 0` disables it.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: `name` (unique) starts a service; finite jobs (tests, builds, CI watch) use `async`, never `name`; ready requires name; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.{{/if}}
{{#if autoBackgroundEnabled}}Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout` (not when the client terminal runs the command or the job cap is reached); the result arrives automatically as a follow-up message. NEVER poll.{{/if}}

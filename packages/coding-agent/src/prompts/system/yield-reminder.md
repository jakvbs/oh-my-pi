<system-reminder>
Last turn had no tool call → session idle. Reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with a tool call. First applicable:
1. **Resume work** — assignment incomplete: call next intended tool (edit, write, bash, search, etc.). NEVER treat this reminder as forced stop.
2. **Yield success** — only if genuinely complete: call `yield` carrying the full result in `data`.
3. **Yield error** — only for a real, concrete, nameable blocker (missing file, unavailable API, contradictory spec): describe attempts and exact blocker. NEVER fabricate a "forced immediate-yield" or "system reminder required termination" reason; reminder not a blocker.

Default option 1 unless work done or blocked.

NEVER end this turn with text only.
</system-reminder>

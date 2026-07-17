{{#if parents~}}
Upstream task results (for context — do not re-do this work):

{{#each parents~}}
{{!dag-task-heading}}### {{id}} [{{status}}]
{{!dag-task-output}}{{output}}

{{/each~}}
---

{{/if~}}
{{subtaskPrompt~}}

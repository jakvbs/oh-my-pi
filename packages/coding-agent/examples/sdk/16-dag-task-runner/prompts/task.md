{{#if parents}}
Upstream task results (for context — do not re-do this work):

{{#each parents}}

### {{id}} [{{status}}]

{{output}}

{{/each}}
---

{{/if}}
{{subtaskPrompt}}

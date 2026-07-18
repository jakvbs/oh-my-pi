{{#with previousAttempt~}}
Previous attempt did not finish successfully in this shared workspace. Partial changes may remain.
You MUST inspect existing changes before editing. Repair or complete them; NEVER assume a clean workspace.
{{#if errorMessage}}
Previous error:
{{errorMessage}}
{{/if}}
{{#if resultText}}
Previous output:
{{resultText}}
{{/if}}
---

{{/with~}}
{{#if parents~}}
Upstream task results (for context — do not re-do this work):

{{#each parents~}}
{{!dag-task-heading}}### {{id}} [{{status}}]
{{!dag-task-output}}{{output}}

{{/each~}}
---

{{/if~}}
{{subtaskPrompt~}}

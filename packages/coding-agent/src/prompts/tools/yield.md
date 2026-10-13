Submit your result: `{ data: <your output> }` for success, `{ error: "message" }` for failure. Never both; never a bare payload outside `data`.
{{#if hasOutputSchema}}

This session declares an output schema: `data` MUST be the full object matching it. A data-less `type: "result"` is invalid — prose in your last turn can never satisfy the schema.
{{else}}

Pass `type: "result"` without `data` to use your last assistant turn as the raw final result.
{{/if}}

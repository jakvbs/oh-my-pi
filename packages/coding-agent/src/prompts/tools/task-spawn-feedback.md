{{#if singleCall}}Spawned agent `{{agentId}}` (job `{{jobId}}`).{{else}}Spawned {{count}} background agent{{#unless singular}}s{{/unless}} using {{agentLabel}}.{{scheduleFailureSummary}}{{/if}}
{{#if showListing}}{{#each started}}- `{{agentId}}` (job `{{jobId}}`)
{{/each}}{{/if}}
{{{guidance}}}

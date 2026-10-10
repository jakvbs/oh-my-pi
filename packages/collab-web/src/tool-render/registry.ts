/**
 * Tool renderer registry. Keys are current wire tool names.
 * Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astEditRenderer } from "./tools/ast-edit";
import { astGrepRenderer } from "./tools/ast-grep";
import { bashRenderer } from "./tools/bash";
import { editRenderer } from "./tools/edit";
import { fetchRenderer } from "./tools/fetch";
import { githubRenderer } from "./tools/github";
import { globRenderer } from "./tools/glob";
import { goalRenderer } from "./tools/goal";
import { grepRenderer } from "./tools/grep";
import { waitRenderer } from "./tools/wait";
import { lspRenderer } from "./tools/lsp";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { webSearchRenderer } from "./tools/web-search";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast_edit: astEditRenderer,
	ast_grep: astGrepRenderer,
	bash: bashRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	fetch: fetchRenderer,
	glob: globRenderer,
	find: globRenderer,
	github: githubRenderer,
	goal: goalRenderer,
	wait: waitRenderer,
	lsp: lspRenderer,
	read: readRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return RENDERERS[name] ?? genericRenderer;
}

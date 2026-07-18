/**
 * DAG schema parsing, validation, and topological ranking for the runner.
 *
 * The DAG file shape is intentionally tiny — see ./example-dag.json.
 */

import * as path from "node:path";

export type Complexity = "HIGH" | "MED" | "LOW";
export type ModelMap = Record<Complexity, string>;
export type ModelMapOverride = Partial<ModelMap>;

export interface RawTask {
	id: string;
	depends_on: string[];
	context_from: string[];
	writes: string[];
	complexity: Complexity;
	subtask_prompt: string;
}

export interface DAG {
	title: string;
	goal: string;
	success_criteria: string[];
	models?: ModelMapOverride;
	tasks: RawTask[];
}

export type DAGDiagnosticCode =
	| "INVALID_ROOT"
	| "INVALID_GOAL"
	| "INVALID_SUCCESS_CRITERIA"
	| "INVALID_TASK"
	| "DUPLICATE_ID"
	| "UNKNOWN_DEPENDENCY"
	| "SELF_DEPENDENCY"
	| "INVALID_CONTEXT_SOURCE"
	| "CYCLE"
	| "INVALID_WRITE_PATH"
	| "WRITE_CONFLICT"
	| "INVALID_MODEL_MAP";

export interface DAGDiagnostic {
	severity: "error";
	code: DAGDiagnosticCode;
	message: string;
	taskId?: string;
	field?: string;
}

export interface DAGValidationResult {
	ok: boolean;
	diagnostics: DAGDiagnostic[];
	dag?: DAG;
}

export class DAGValidationError extends Error {
	readonly diagnostics: DAGDiagnostic[];

	constructor(diagnostics: DAGDiagnostic[]) {
		super(formatDiagnostics(diagnostics));
		this.name = "DAGValidationError";
		this.diagnostics = diagnostics;
	}
}

const COMPLEXITY_KEYS = ["HIGH", "MED", "LOW"] as const satisfies readonly Complexity[];

export const DEFAULT_MODEL_MAP: ModelMap = {
	HIGH: "gpt-5.3-codex",
	MED: "composer-2",
	LOW: "auto-low",
};

export function formatDiagnostics(diagnostics: readonly DAGDiagnostic[]): string {
	return diagnostics
		.map(diagnostic => {
			const location = [diagnostic.taskId !== undefined ? `task ${diagnostic.taskId}` : undefined, diagnostic.field]
				.filter((part): part is string => part !== undefined)
				.join(", ");
			return location.length > 0
				? `${diagnostic.code} (${location}): ${diagnostic.message}`
				: `${diagnostic.code}: ${diagnostic.message}`;
		})
		.join("\n");
}

export function validateDAG(raw: unknown): DAGValidationResult {
	const diagnostics: DAGDiagnostic[] = [];
	if (!isRecord(raw)) {
		return {
			ok: false,
			diagnostics: [
				{
					severity: "error",
					code: "INVALID_ROOT",
					message: "DAG file must be a JSON object.",
				},
			],
		};
	}
	const obj = raw;

	let title: string | undefined;
	if (typeof obj.title !== "string" || obj.title.trim() === "") {
		diagnostics.push({
			severity: "error",
			code: "INVALID_ROOT",
			field: "title",
			message: "DAG.title must be a non-empty string.",
		});
	} else {
		title = obj.title;
	}

	let goal: string | undefined;
	if (typeof obj.goal !== "string" || obj.goal.trim() === "") {
		diagnostics.push({
			severity: "error",
			code: "INVALID_GOAL",
			field: "goal",
			message: "DAG.goal must be a non-empty string.",
		});
	} else {
		goal = obj.goal;
	}

	let successCriteria: string[] | undefined;
	if (!Array.isArray(obj.success_criteria)) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_SUCCESS_CRITERIA",
			field: "success_criteria",
			message: "DAG.success_criteria must be a non-empty array of strings.",
		});
	} else if (obj.success_criteria.length === 0) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_SUCCESS_CRITERIA",
			field: "success_criteria",
			message: "DAG.success_criteria must be a non-empty array of strings.",
		});
	} else {
		const criteriaDiagnostics: DAGDiagnostic[] = [];
		const seen = new Set<string>();
		const deduped: string[] = [];
		for (let index = 0; index < obj.success_criteria.length; index++) {
			const criterion = obj.success_criteria[index];
			if (typeof criterion !== "string") {
				criteriaDiagnostics.push({
					severity: "error",
					code: "INVALID_SUCCESS_CRITERIA",
					field: `success_criteria[${index}]`,
					message: `DAG.success_criteria[${index}] must be a non-empty string.`,
				});
				continue;
			}
			if (criterion.trim() === "") {
				criteriaDiagnostics.push({
					severity: "error",
					code: "INVALID_SUCCESS_CRITERIA",
					field: `success_criteria[${index}]`,
					message: `DAG.success_criteria[${index}] must be a non-empty string.`,
				});
				continue;
			}
			if (seen.has(criterion)) continue;
			seen.add(criterion);
			deduped.push(criterion);
		}
		diagnostics.push(...criteriaDiagnostics);
		if (criteriaDiagnostics.length === 0) {
			if (deduped.length === 0) {
				diagnostics.push({
					severity: "error",
					code: "INVALID_SUCCESS_CRITERIA",
					field: "success_criteria",
					message: "DAG.success_criteria must be a non-empty array of strings.",
				});
			} else {
				successCriteria = deduped;
			}
		}
	}

	let models: ModelMapOverride | undefined;
	if (obj.models !== undefined) {
		const modelResult = collectModelMapDiagnostics(obj.models, "DAG.models");
		diagnostics.push(...modelResult.diagnostics);
		if (modelResult.models !== undefined) models = modelResult.models;
	}

	if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_ROOT",
			field: "tasks",
			message: "DAG.tasks must be a non-empty array.",
		});
		return { ok: false, diagnostics };
	}

	const taskResults = obj.tasks.map((task, index) => collectTaskDiagnostics(task, index));
	for (const result of taskResults) diagnostics.push(...result.diagnostics);

	const idOwners = new Map<string, number[]>();
	for (let index = 0; index < taskResults.length; index++) {
		const id = taskResults[index].id;
		if (id === undefined) continue;
		const owners = idOwners.get(id) ?? [];
		owners.push(index);
		idOwners.set(id, owners);
	}
	const duplicateIds = new Set<string>();
	const knownIds = new Set<string>();
	for (const [id, owners] of idOwners) {
		if (owners.length < 2) {
			knownIds.add(id);
			continue;
		}
		duplicateIds.add(id);
		diagnostics.push({
			severity: "error",
			code: "DUPLICATE_ID",
			taskId: id,
			field: "id",
			message: `Duplicate task id: ${id}`,
		});
	}

	for (const parsed of taskResults) {
		if (parsed.id === undefined || !parsed.dependsOnUsable || parsed.depends_on === undefined) continue;
		if (duplicateIds.has(parsed.id)) continue;
		for (const dep of parsed.depends_on) {
			if (dep === parsed.id) {
				diagnostics.push({
					severity: "error",
					code: "SELF_DEPENDENCY",
					taskId: parsed.id,
					field: "depends_on",
					message: `Task ${parsed.id} depends on itself.`,
				});
				continue;
			}
			if (!knownIds.has(dep) && !duplicateIds.has(dep)) {
				diagnostics.push({
					severity: "error",
					code: "UNKNOWN_DEPENDENCY",
					taskId: parsed.id,
					field: "depends_on",
					message: `Task ${parsed.id} depends_on unknown id: ${dep}`,
				});
			}
		}
		if (!parsed.contextFromUsable || parsed.context_from === undefined) continue;
		for (const contextId of parsed.context_from) {
			if (!parsed.depends_on.includes(contextId)) {
				diagnostics.push({
					severity: "error",
					code: "INVALID_CONTEXT_SOURCE",
					taskId: parsed.id,
					field: "context_from",
					message: `Task ${parsed.id} context_from must be a subset of depends_on: ${contextId}`,
				});
			}
		}
	}

	const usableById = new Map<string, RawTask>();
	for (const parsed of taskResults) {
		if (!parsed.task || duplicateIds.has(parsed.task.id)) continue;
		usableById.set(parsed.task.id, parsed.task);
	}

	const graphTasks = [...usableById.values()];
	const graphUsable =
		graphTasks.length > 0 && graphTasks.every(task => task.depends_on.every(dep => usableById.has(dep)));

	if (graphUsable) {
		const cycle = detectCycle(graphTasks);
		if (cycle) {
			diagnostics.push({
				severity: "error",
				code: "CYCLE",
				message: `Cycle detected: ${cycle}`,
			});
		}
		for (const conflict of collectWriteConflicts(graphTasks)) {
			diagnostics.push(conflict);
		}
	}

	if (diagnostics.length > 0 || title === undefined || goal === undefined || successCriteria === undefined) {
		return { ok: false, diagnostics };
	}

	const tasks = taskResults.map(result => result.task).filter((task): task is RawTask => task !== undefined);
	if (tasks.length !== obj.tasks.length || duplicateIds.size > 0) {
		return { ok: false, diagnostics };
	}

	return {
		ok: true,
		diagnostics: [],
		dag: {
			title,
			goal,
			success_criteria: successCriteria,
			models,
			tasks,
		},
	};
}

export function parseDAG(raw: unknown): DAG {
	const result = validateDAG(raw);
	if (!result.ok || !result.dag) {
		throw new DAGValidationError(result.diagnostics);
	}
	return result.dag;
}

interface CollectedTask {
	diagnostics: DAGDiagnostic[];
	id?: string;
	task?: RawTask;
	depends_on?: string[];
	context_from?: string[];
	dependsOnUsable: boolean;
	contextFromUsable: boolean;
}

function collectTaskDiagnostics(raw: unknown, index: number): CollectedTask {
	const diagnostics: DAGDiagnostic[] = [];
	if (!isRecord(raw)) {
		return {
			diagnostics: [
				{
					severity: "error",
					code: "INVALID_TASK",
					field: `tasks[${index}]`,
					message: `tasks[${index}] must be an object.`,
				},
			],
			dependsOnUsable: false,
			contextFromUsable: false,
		};
	}
	const t = raw;
	let id: string | undefined;
	if (typeof t.id !== "string" || t.id.trim() === "") {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			field: `tasks[${index}].id`,
			message: `tasks[${index}].id must be a non-empty string.`,
		});
	} else {
		id = t.id;
	}

	let depends_on: string[] | undefined;
	let dependsOnUsable = false;
	const dependsRaw = t.depends_on ?? [];
	if (!isStringArray(dependsRaw)) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			taskId: id,
			field: `tasks[${index}].depends_on`,
			message: `tasks[${index}].depends_on must be an array of strings.`,
		});
	} else {
		depends_on = [...new Set(dependsRaw)];
		dependsOnUsable = id !== undefined;
	}

	let context_from: string[] | undefined;
	let contextFromUsable = false;
	if (!isStringArray(t.context_from)) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			taskId: id,
			field: `tasks[${index}].context_from`,
			message: `tasks[${index}].context_from must be an array of strings.`,
		});
	} else {
		context_from = [...new Set(t.context_from)];
		contextFromUsable = dependsOnUsable;
	}

	let writes: string[] | undefined;
	if (!isStringArray(t.writes)) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			taskId: id,
			field: `tasks[${index}].writes`,
			message: `tasks[${index}].writes must be an array of strings.`,
		});
	} else {
		const normalizedWrites: string[] = [];
		const seen = new Set<string>();
		let writePathErrors = false;
		for (let writeIndex = 0; writeIndex < t.writes.length; writeIndex++) {
			const writeResult = validateWritePath(t.writes[writeIndex], index, writeIndex);
			if (writeResult.diagnostic) {
				writePathErrors = true;
				diagnostics.push({
					...writeResult.diagnostic,
					taskId: id,
				});
				continue;
			}
			if (seen.has(writeResult.value)) continue;
			seen.add(writeResult.value);
			normalizedWrites.push(writeResult.value);
		}
		if (!writePathErrors) writes = normalizedWrites;
	}

	let complexity: Complexity | undefined;
	if (!isComplexity(t.complexity)) {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			taskId: id,
			field: `tasks[${index}].complexity`,
			message: `tasks[${index}].complexity must be one of HIGH | MED | LOW.`,
		});
	} else {
		complexity = t.complexity;
	}

	let subtask_prompt: string | undefined;
	if (typeof t.subtask_prompt !== "string" || t.subtask_prompt.trim() === "") {
		diagnostics.push({
			severity: "error",
			code: "INVALID_TASK",
			taskId: id,
			field: `tasks[${index}].subtask_prompt`,
			message: `tasks[${index}].subtask_prompt must be a non-empty string.`,
		});
	} else {
		subtask_prompt = t.subtask_prompt;
	}

	const partial = {
		diagnostics,
		id,
		depends_on,
		context_from,
		dependsOnUsable,
		contextFromUsable,
	};
	if (
		id === undefined ||
		depends_on === undefined ||
		context_from === undefined ||
		writes === undefined ||
		complexity === undefined ||
		subtask_prompt === undefined
	) {
		return partial;
	}

	return {
		...partial,
		task: {
			id,
			depends_on,
			context_from,
			writes,
			complexity,
			subtask_prompt,
		},
	};
}

/** Returns the cycle path string on the first cycle found. Uses iterative DFS with a recursion stack. */
function detectCycle(tasks: RawTask[]): string | undefined {
	const adj = new Map<string, string[]>();
	for (const t of tasks) adj.set(t.id, []);
	for (const t of tasks) {
		for (const dep of t.depends_on) {
			adj.get(dep)!.push(t.id);
		}
	}

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const t of tasks) color.set(t.id, WHITE);

	for (const start of tasks) {
		if (color.get(start.id) !== WHITE) continue;
		const stack: Array<{ id: string; childIdx: number }> = [{ id: start.id, childIdx: 0 }];
		const path: string[] = [];
		color.set(start.id, GRAY);
		path.push(start.id);

		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const children = adj.get(top.id)!;
			if (top.childIdx >= children.length) {
				color.set(top.id, BLACK);
				path.pop();
				stack.pop();
				continue;
			}
			const child = children[top.childIdx++];
			const cColor = color.get(child) ?? WHITE;
			if (cColor === GRAY) {
				const cycleStart = path.indexOf(child);
				return [...path.slice(cycleStart), child].join(" -> ");
			}
			if (cColor === WHITE) {
				color.set(child, GRAY);
				path.push(child);
				stack.push({ id: child, childIdx: 0 });
			}
		}
	}
	return undefined;
}

function validateWritePath(
	value: string,
	taskIndex: number,
	writeIndex: number,
): { value: string; diagnostic?: DAGDiagnostic } {
	const segments = value.split("/");
	const isInvalid =
		value === "" ||
		value.trim() !== value ||
		value.includes("\0") ||
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		/^[A-Za-z]:/.test(value) ||
		value.endsWith("/") ||
		path.posix.normalize(value) !== value ||
		segments.some(segment => segment === "." || segment === "..") ||
		/[*?[\]{}]/.test(value);
	if (value !== "*" && isInvalid) {
		return {
			value,
			diagnostic: {
				severity: "error",
				code: "INVALID_WRITE_PATH",
				field: `tasks[${taskIndex}].writes[${writeIndex}]`,
				message: `tasks[${taskIndex}].writes[${writeIndex}] must be "*" or an exact normalized repo-relative path.`,
			},
		};
	}
	return { value };
}

function collectWriteConflicts(tasks: RawTask[]): DAGDiagnostic[] {
	const byId = new Map<string, RawTask>();
	for (const task of tasks) byId.set(task.id, task);

	const ancestorsById = new Map<string, Set<string>>();
	for (const task of tasks) {
		const ancestors = new Set<string>();
		const stack = [...task.depends_on];
		while (stack.length > 0) {
			const ancestorId = stack.pop()!;
			if (ancestors.has(ancestorId)) continue;
			ancestors.add(ancestorId);
			stack.push(...byId.get(ancestorId)!.depends_on);
		}
		ancestorsById.set(task.id, ancestors);
	}

	const diagnostics: DAGDiagnostic[] = [];
	for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
		const left = tasks[leftIndex];
		for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
			const right = tasks[rightIndex];
			const overlap = overlappingWrite(left.writes, right.writes);
			if (
				overlap === undefined ||
				ancestorsById.get(left.id)!.has(right.id) ||
				ancestorsById.get(right.id)!.has(left.id)
			) {
				continue;
			}
			diagnostics.push({
				severity: "error",
				code: "WRITE_CONFLICT",
				taskId: left.id,
				field: "writes",
				message: `Tasks ${left.id} and ${right.id} have unordered overlapping writes: ${overlap}. Add a dependency or split their writes.`,
			});
		}
	}
	return diagnostics;
}

function overlappingWrite(left: readonly string[], right: readonly string[]): string | undefined {
	if (left.length === 0 || right.length === 0) return undefined;
	if (left.includes("*")) return right.includes("*") ? "*" : right[0];
	if (right.includes("*")) return left[0];
	return left.find(write => right.includes(write));
}

/**
 * Kahn's algorithm — return tasks grouped into ranks. Tasks within a rank
 * have no inter-dependencies and can run in parallel.
 */
export function computeRanks(dag: DAG): RawTask[][] {
	const remaining = new Map<string, number>();
	const byId = new Map<string, RawTask>();
	for (const t of dag.tasks) {
		remaining.set(t.id, t.depends_on.length);
		byId.set(t.id, t);
	}
	const dependents = new Map<string, string[]>();
	for (const t of dag.tasks) dependents.set(t.id, []);
	for (const t of dag.tasks) {
		for (const dep of t.depends_on) {
			dependents.get(dep)!.push(t.id);
		}
	}

	const ranks: RawTask[][] = [];
	let frontier = dag.tasks.filter(t => remaining.get(t.id) === 0);
	while (frontier.length > 0) {
		ranks.push(frontier);
		const next: RawTask[] = [];
		for (const t of frontier) {
			for (const child of dependents.get(t.id)!) {
				const r = remaining.get(child)! - 1;
				remaining.set(child, r);
				if (r === 0) next.push(byId.get(child)!);
			}
		}
		frontier = next;
	}

	const placed = ranks.reduce((n, r) => n + r.length, 0);
	if (placed !== dag.tasks.length) {
		throw new Error("Topological sort failed — DAG contains a cycle.");
	}
	return ranks;
}

function collectModelMapDiagnostics(
	raw: unknown,
	label: string,
): { diagnostics: DAGDiagnostic[]; models?: ModelMapOverride } {
	if (!isRecord(raw)) {
		return {
			diagnostics: [
				{
					severity: "error",
					code: "INVALID_MODEL_MAP",
					field: label,
					message: `${label} must be a JSON object.`,
				},
			],
		};
	}
	const diagnostics: DAGDiagnostic[] = [];
	const models: ModelMapOverride = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isComplexity(key)) {
			diagnostics.push({
				severity: "error",
				code: "INVALID_MODEL_MAP",
				field: `${label}.${key}`,
				message: `${label} contains unknown complexity key: ${key}`,
			});
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			diagnostics.push({
				severity: "error",
				code: "INVALID_MODEL_MAP",
				field: `${label}.${key}`,
				message: `${label}.${key} must be a non-empty string.`,
			});
			continue;
		}
		models[key] = value.trim();
	}
	if (diagnostics.length > 0) return { diagnostics };
	return { diagnostics: [], models };
}

export function validateModelMap(raw: unknown, label = "model map"): ModelMapOverride {
	const result = collectModelMapDiagnostics(raw, label);
	if (result.diagnostics.length > 0 || result.models === undefined) {
		throw new DAGValidationError(result.diagnostics);
	}
	return result.models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isComplexity(value: unknown): value is Complexity {
	return value === "HIGH" || value === "MED" || value === "LOW";
}

export function createModelResolver(overrides: ModelMapOverride = {}): (c: Complexity) => string {
	const models: ModelMap = { ...DEFAULT_MODEL_MAP, ...overrides };
	return (c: Complexity): string => {
		if (!COMPLEXITY_KEYS.includes(c)) {
			throw new Error(`Unknown complexity: ${c}`);
		}
		return models[c];
	};
}

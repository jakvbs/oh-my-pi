/**
 * DAG schema parsing, validation, and topological ranking for the runner.
 *
 * The DAG file shape is intentionally tiny — see ../examples/example_dag.json.
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
	models?: ModelMapOverride;
	tasks: RawTask[];
}

const COMPLEXITY_KEYS = ["HIGH", "MED", "LOW"] as const satisfies readonly Complexity[];

export const DEFAULT_MODEL_MAP: ModelMap = {
	HIGH: "gpt-5.3-codex",
	MED: "composer-2",
	LOW: "auto-low",
};

export function parseDAG(raw: unknown): DAG {
	if (!isRecord(raw)) {
		throw new Error("DAG file must be a JSON object.");
	}
	const obj = raw;
	if (typeof obj.title !== "string" || obj.title.trim() === "") {
		throw new Error("DAG.title must be a non-empty string.");
	}
	if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
		throw new Error("DAG.tasks must be a non-empty array.");
	}

	const tasks: RawTask[] = obj.tasks.map((t, i) => validateTask(t, i));
	const ids = new Set<string>();
	for (const t of tasks) {
		if (ids.has(t.id)) {
			throw new Error(`Duplicate task id: ${t.id}`);
		}
		ids.add(t.id);
	}
	for (const t of tasks) {
		for (const dep of t.depends_on) {
			if (!ids.has(dep)) {
				throw new Error(`Task ${t.id} depends_on unknown id: ${dep}`);
			}
			if (dep === t.id) {
				throw new Error(`Task ${t.id} depends on itself.`);
			}
		}
		for (const contextId of t.context_from) {
			if (!t.depends_on.includes(contextId)) {
				throw new Error(`Task ${t.id} context_from must be a subset of depends_on: ${contextId}`);
			}
		}
	}

	detectCycle(tasks);
	validateWriteConflicts(tasks);

	const models = obj.models === undefined ? undefined : validateModelMap(obj.models, "DAG.models");

	return { title: obj.title, models, tasks };
}

function validateTask(raw: unknown, index: number): RawTask {
	if (!isRecord(raw)) {
		throw new Error(`tasks[${index}] must be an object.`);
	}
	const t = raw;
	const id = t.id;
	if (typeof id !== "string" || id.trim() === "") {
		throw new Error(`tasks[${index}].id must be a non-empty string.`);
	}
	const depends_on = t.depends_on ?? [];
	if (!isStringArray(depends_on)) {
		throw new Error(`tasks[${index}].depends_on must be an array of strings.`);
	}
	const context_from = t.context_from;
	if (!isStringArray(context_from)) {
		throw new Error(`tasks[${index}].context_from must be an array of strings.`);
	}
	const writes = t.writes;
	if (!isStringArray(writes)) {
		throw new Error(`tasks[${index}].writes must be an array of strings.`);
	}
	const complexity = t.complexity;
	if (!isComplexity(complexity)) {
		throw new Error(`tasks[${index}].complexity must be one of HIGH | MED | LOW.`);
	}
	const subtask_prompt = t.subtask_prompt;
	if (typeof subtask_prompt !== "string" || subtask_prompt.trim() === "") {
		throw new Error(`tasks[${index}].subtask_prompt must be a non-empty string.`);
	}
	return {
		id,
		depends_on: [...new Set(depends_on)],
		context_from: [...new Set(context_from)],
		writes: [...new Set(writes.map((write, writeIndex) => validateWritePath(write, index, writeIndex)))],
		complexity,
		subtask_prompt,
	};
}

/** Throws on the first cycle found. Uses iterative DFS with a recursion stack. */
function detectCycle(tasks: RawTask[]): void {
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
		const stack: Array<{ id: string; childIdx: number; pathIdx: number }> = [
			{ id: start.id, childIdx: 0, pathIdx: 0 },
		];
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
				const cycle = [...path.slice(cycleStart), child].join(" -> ");
				throw new Error(`Cycle detected: ${cycle}`);
			}
			if (cColor === WHITE) {
				color.set(child, GRAY);
				path.push(child);
				stack.push({ id: child, childIdx: 0, pathIdx: path.length - 1 });
			}
		}
	}
}

function validateWritePath(value: string, taskIndex: number, writeIndex: number): string {
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
		throw new Error(
			`tasks[${taskIndex}].writes[${writeIndex}] must be "*" or an exact normalized repo-relative path.`,
		);
	}
	return value;
}

function validateWriteConflicts(tasks: RawTask[]): void {
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
			throw new Error(
				`Tasks ${left.id} and ${right.id} have unordered overlapping writes: ${overlap}. Add a dependency or split their writes.`,
			);
		}
	}
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

export function validateModelMap(raw: unknown, label = "model map"): ModelMapOverride {
	if (!isRecord(raw)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	const models: ModelMapOverride = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isComplexity(key)) {
			throw new Error(`${label} contains unknown complexity key: ${key}`);
		}
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error(`${label}.${key} must be a non-empty string.`);
		}
		models[key] = value.trim();
	}
	return models;
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

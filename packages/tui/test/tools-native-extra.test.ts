import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { TspChecklistProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { TodoToolDetails } from "../src/tools/todo";
import { todoToolRenderer } from "../src/tools/todo";
import type { CoordinationDetails } from "../src/tools/wait";
import { waitToolRenderer } from "../src/tools/wait";

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) {
			out.push(child, ...nodes(child.c));
		}
	}
	return out;
}

const opts = { expanded: false, isPartial: false };

describe("native todo", () => {
	it("renders one checklist with mapped statuses, plain phase titles and folded completed phases", () => {
		const details: TodoToolDetails = {
			storage: "memory",
			phases: [
				{ name: "Setup", tasks: [{ content: "init", status: "completed" }] },
				{
					name: "Build",
					tasks: [
						{ content: "write parser", status: "completed" },
						{ content: "lex", status: "in_progress" },
						{ content: "old idea", status: "abandoned" },
						{ content: "deploy", status: "blocked", blocker: "no creds" },
						{ content: "ship it", status: "pending" },
					],
				},
			],
		};
		const view = todoToolRenderer.describeResult({ content: [], details }, opts);
		expect(view?.tool).toMatchObject({ title: "Todo", target: "3/6", targetKind: "text" });
		expect(view?.body).toHaveLength(1);
		const checklist = view?.body?.[0] as NativeNode;
		expect(checklist.k).toBe("checklist");
		const p = checklist.p as TspChecklistProps;
		expect(p.mode).toBe("full");
		expect(p.phases.map(phase => [phase.title, phase.collapsed])).toEqual([
			["Setup", true],
			["Build", false],
		]);
		expect(p.phases[1]!.items.map(item => [item.text, item.status, item.note])).toEqual([
			["write parser", "done", undefined],
			["lex", "active", undefined],
			["old idea", "dropped", undefined],
			["deploy", "blocked", "no creds"],
			["ship it", "pending", undefined],
		]);
	});
});

describe("native wait", () => {
	afterEach(() => setNativeRendering(false));

	it("describes running jobs with a terminal-clocked elapsed and schedules no timer", () => {
		setNativeRendering(true);
		const interval = spyOn(globalThis, "setInterval");
		const timeout = spyOn(globalThis, "setTimeout");
		try {
			const details: CoordinationDetails = {
				op: "wait",
				jobs: [
					{ id: "job-1", type: "bash", status: "running", label: "sleep", durationMs: 4200 },
					{ id: "job-2", type: "eval", status: "completed", label: "x", durationMs: 900 },
				],
			};
			const view = waitToolRenderer.describeResult({ content: [], details }, { ...opts, isPartial: true });
			const clocks = nodes(view?.body)
				.filter(n => n.k === "elapsed")
				.map(n => n.p);
			expect(clocks).toEqual([
				{ age: 4200, format: "short" },
				{ age: 900, stopped: 900, format: "short" },
			]);
			expect(interval).not.toHaveBeenCalled();
			expect(timeout).not.toHaveBeenCalled();
		} finally {
			interval.mockRestore();
			timeout.mockRestore();
		}
	});
});

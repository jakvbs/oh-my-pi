/**
 * The wait tool's TUI preview of background jobs: job text previews flatten
 * pretty-printed JSON, and the id column is dropped when the label repeats it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";

function renderLines(resultText: string): string {
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			op: "wait" as const,
			jobs: [
				{
					id: "SpawnProbe",
					type: "bash" as const,
					status: "completed" as const,
					label: "SpawnProbe",
					durationMs: 8_700,
					resultText,
				},
			],
		},
	};
	const component = waitToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer preview", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("flattens a pretty-printed JSON body instead of previewing a lone brace", () => {
		const output = Bun.stripANSI(renderLines('{\n  "echo": "alpha",\n  "ok": true\n}'));
		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("drops the id column when the label repeats it", () => {
		// Rendering both columns stutters ("SpawnProbe ⟨bash⟩ SpawnProbe").
		const output = Bun.stripANSI(renderLines("done"));
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	describe("live and sealed waiting snapshots", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "bash" as const,
				status: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "bash" as const,
				status: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "bash" as const,
				status: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains running and settled jobs after a poll is sealed", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains the worker identity in a sealed all-running poll", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "bash" as const,
					status: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: runningJobsOnly },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const lines = component.render(120) as readonly string[];
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Job1 running");
		});

		it("retains the running job in the sealed native wait card", () => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: { op: "wait" as const, jobs: [jobsData[0]] },
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			expect(view?.head).toEqual(expect.arrayContaining([expect.objectContaining({ t: "waiting on 1 job" })]));
			expect(JSON.stringify(view?.body)).toContain("Job1 running");
		});

		it.each([true, false])("animates running native rows only while the poll is live (%s)", isPartial => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: {
					op: "wait" as const,
					jobs: [jobsData[0], jobsData[1]],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial });
			const rows = view!.body!;
			expect(rows[0]).toMatchObject({
				c: [
					{ k: "badge" },
					{ k: "text", p: { spans: [isPartial ? { fx: "shimmer" } : { t: "Job1" }, expect.any(Object)] } },
					{ k: "elapsed", p: isPartial ? { age: 1200 } : { age: 1200, stopped: 1200 } },
				],
			});
			if (!isPartial) expect(JSON.stringify(view)).not.toContain('"fx":"shimmer"');
			else {
				expect(JSON.stringify(rows[0])).not.toContain('"stopped"');
			}
		});

		it("keeps a settled native job to its one line: output and errors fill the call's own card", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [
						{
							id: "bg_2",
							type: "bash" as const,
							status: "failed" as const,
							label: "hyperfine --runs 30 bench",
							durationMs: 61_000,
							exitCode: 1,
							resultText: "Benchmark 1: calc_ir",
							errorText: "Command exited with code 1",
							meta: { artifactError: "write" as const },
						},
					],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			const [job] = view!.body!;
			expect(job).toMatchObject({ k: "row", p: { role: "omp.wait.job", tone: "error" } });
			const json = JSON.stringify(view);
			expect(json).toContain("hyperfine --runs 30 bench");
			expect(json).not.toContain("Benchmark 1");
			expect(json).not.toContain("exited with code 1");
			expect(json).not.toContain("artifact write failed");
		});
	});
});

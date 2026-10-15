import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type AgentToolResult, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("wait", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("bash", "echo", async () => "received=kestrel42", { ownerId: "Main" });
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("wakes on an error line in a running bash job and does not wake again for it", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		let report!: (text: string) => Promise<void>;
		const started = Promise.withResolvers<void>();
		const id = manager.register(
			"bash",
			"cargo build",
			async ({ reportProgress }) => {
				report = reportProgress;
				started.resolve();
				return promise;
			},
			{ ownerId: "Main" },
		);
		await started.promise;
		await report("Compiling a v0.1.0\n");
		const wait = new WaitTool(session(manager), { stallMs: 60_000, outputCheckIntervalMs: 5 });
		const first = wait.execute("wait-error", {});
		await report("Compiling a v0.1.0\nerror[E0308]: mismatched types\n  --> src/lib.rs:3:5\n");
		const result = await first;
		expect(result.content).toEqual([
			{
				type: "text",
				text: [
					"## Output alert\n",
					`\`${id}\` printed an error line and is still running.`,
					"```",
					"Compiling a v0.1.0\nerror[E0308]: mismatched types\n  --> src/lib.rs:3:5",
					"```",
					"Call `wait` again to keep waiting, or cancel the job if this output makes the rest of the run moot.",
					"",
					"## Still Running (1)\n",
					`- \`${id}\` [bash] — cargo build`,
				].join("\n"),
			},
		]);
		expect(result.useless).toBeUndefined();

		const second = wait.execute("wait-after-error", {});
		resolve("build failed");
		expect((await second).details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build failed" });
	});

	test("a job silent by design does not wake the wait before it finishes", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "gh run watch 1 >/dev/null 2>&1", async () => promise, { ownerId: "Main" });
		const wait = new WaitTool(session(manager), { stallMs: 5 * 60_000, outputCheckIntervalMs: 1_000 });
		const waiting = wait.execute("wait-silent", {});
		vi.advanceTimersByTime(10 * 60_000);
		resolve("run passed");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "run passed" });
	});

	test("wakes once when a job that kept printing falls silent", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		let report!: (text: string) => Promise<void>;
		const id = manager.register(
			"bash",
			"bun test",
			async ({ reportProgress }) => {
				report = reportProgress;
				return promise;
			},
			{ ownerId: "Main" },
		);
		const wait = new WaitTool(session(manager), { stallMs: 5 * 60_000, outputCheckIntervalMs: 1_000 });
		const stalled = wait.execute("wait-stall", {});
		let output = "";
		for (const line of ["(pass) a", "(pass) b", "(pass) c", "running d"]) {
			output += `${line}\n`;
			await report(output);
			vi.advanceTimersByTime(20_000);
		}
		vi.advanceTimersByTime(5 * 60_000);
		const text = textOf(await stalled);
		expect(text).toContain(`\`${id}\` printed nothing for 5 min`);
		expect(text).toContain("(pass) c\nrunning d\n```");

		const second = wait.execute("wait-after-stall", {});
		vi.advanceTimersByTime(20 * 60_000);
		resolve("suite passed");
		expect((await second).details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "suite passed" });
	});

	test("an error line that a redrawn status frame repeats wakes only once", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		let report!: (text: string) => Promise<void>;
		const id = manager.register(
			"bash",
			"watch-status",
			async ({ reportProgress }) => {
				report = reportProgress;
				return promise;
			},
			{ ownerId: "Main" },
		);
		const frame = (state: string) => `Refreshing status every 60 seconds.\nFAIL lint\n${state} build\n`;
		await report(frame("*"));
		const wait = new WaitTool(session(manager), { stallMs: 5 * 60_000, outputCheckIntervalMs: 1_000 });
		const first = await wait.execute("wait-first-frame", {});
		expect(textOf(first)).toContain(`\`${id}\` printed an error line`);

		const second = wait.execute("wait-redraws", {});
		await report(frame("*") + frame("*"));
		vi.advanceTimersByTime(60_000);
		await report(frame("*") + frame("*") + frame("✓"));
		vi.advanceTimersByTime(60_000);
		resolve("run finished");
		expect((await second).details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "run finished" });
	});

	test("a wait that reaches its limit says so and how long each job has run", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "gh run watch 2", async () => promise, { ownerId: "Main" });
		const wait = new WaitTool(session(manager), { stallMs: 5 * 60_000, outputCheckIntervalMs: 1_000 });
		const waiting = wait.execute("wait-limit", {});
		vi.advanceTimersByTime(30 * 60_000);
		const text = textOf(await waiting);
		expect(text).toStartWith("## Wait limit reached\n");
		expect(text).toContain(`\`${id}\` has run 30 min and printed nothing.`);
		resolve("done");
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted by message." }]);
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a hung daemon broker does not fail the wait; the job result still arrives", async () => {
		const hungBroker = {
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(hungBroker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager, "Main", true)).execute("wait-hung-broker", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
	});

	// A failing command settles as a failed job whose log is its error text, not its result.
	for (const outcome of ["completed", "failed"] as const) {
		test(`a recovered long ${outcome} job shows its tail inline and keeps the full output in an artifact`, async () => {
			await using temp = await TempDir.create("@wait-preview-");
			const artifactPath = path.join(temp.path(), "1.async.log");
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const toolSession: ToolSession = {
				cwd: temp.path(),
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated({ "launch.enabled": false }),
				asyncJobManager: manager,
				getAgentId: () => "Main",
				allocateOutputArtifact: async () => ({ id: "1", path: artifactPath }),
			};
			const log = `${"compiling module\n".repeat(1500)}MIDDLE-OF-LOG\n${"linking\n".repeat(1500)}Tests: 3 failed, 77 passed`;
			const { promise, resolve, reject } = Promise.withResolvers<string>();
			manager.register("bash", "verify", async () => promise, { ownerId: "Main" });
			const waiting = new WaitTool(toolSession).execute("wait-long", {});
			if (outcome === "completed") resolve(log);
			else reject(new Error(log));
			const text = textOf(await waiting);
			expect(text).toContain(`[bash] — ${outcome}`);
			expect(text).toContain("Tests: 3 failed, 77 passed");
			expect(text).not.toContain("MIDDLE-OF-LOG");
			expect(text).toContain("Full output: artifact://1");
			expect(text.length).toBeLessThan(5_000);
			expect(await Bun.file(artifactPath).text()).toBe(log);
		});
	}
});

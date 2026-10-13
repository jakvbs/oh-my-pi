import { afterEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
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
});

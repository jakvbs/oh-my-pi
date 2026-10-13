import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { scheduler } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "bun:test";

async function waitForJobEviction(manager: AsyncJobManager, jobId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (manager.getJob(jobId)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for job eviction: ${jobId}`);
		await scheduler.yield();
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await scheduler.yield();
	}
}

describe("AsyncJobManager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("bounds owner-job reap while preserving late settlement", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"ignores abort",
			async () => {
				await release.promise;
				return "late result";
			},
			{ ownerId: "owner" },
		);

		const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());

		expect(reap.settled).toBe(false);
		expect(reap.pendingJobIds).toEqual([jobId]);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");

		release.resolve();
		await reap.completion;
		expect(manager.getJob(jobId)?.resultText).toBe("late result");
	});

	test.each(["single", "bulk"] as const)("keeps %s cancelled work reapable past retention", async kind => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ retentionMs: 25 });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"pending cleanup",
			async () => {
				await release.promise;
				return "cleanup finished";
			},
			{ ownerId: "owner" },
		);
		try {
			if (kind === "single") manager.cancel(jobId);
			else manager.cancelAll({ ownerId: "owner" });
			vi.advanceTimersByTime(50);
			const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());
			expect(reap.settled).toBe(false);
			expect(reap.pendingJobIds).toEqual([jobId]);
			release.resolve();
			await reap.completion;
			expect(manager.getJob(jobId)?.resultText).toBe("cleanup finished");
			expect(await manager.waitForOwnerJobs("owner")).toBe(true);
			vi.advanceTimersByTime(25);
			expect(manager.getJob(jobId)).toBeUndefined();
		} finally {
			release.resolve();
			await manager.waitForAll();
			await manager.dispose();
			vi.useRealTimers();
		}
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"bash",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("bash", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await waitForJobEviction(manager, jobId);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("never recycles auto ids after settled jobs are evicted", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		const first = manager.register("bash", "first", async () => "one");
		const second = manager.register("bash", "second", async () => "two");
		await manager.waitForAll();
		expect(manager.getJob(first)).toBeUndefined();
		expect(manager.getJob(second)).toBeUndefined();

		const third = manager.register("bash", "third", async () => "three");
		expect([first, second, third]).toEqual(["bg_1", "bg_2", "bg_3"]);
		await manager.dispose();
	});

	test("keeps a foreground-backed job out of listings and delivery unless promoted", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				completions.push(jobId);
			},
		});

		// Released before its body settles (the foreground waiter wins the race).
		const pending = Promise.withResolvers<string>();
		const racing = manager.register("bash", "racing foreground", () => pending.promise, { foreground: true });
		expect(manager.getAllJobs()).toEqual([]);
		expect(manager.getRunningJobs()).toEqual([]);
		manager.releaseForegroundJob(racing);
		pending.resolve("done");
		await manager.waitForAll();
		expect(manager.getJob(racing)).toBeUndefined();

		// Settled before promotion: stays hidden until promoted, then delivers once.
		const promoted = manager.register("bash", "promoted", async () => "slow", { foreground: true });
		expect(promoted).toBe(racing);
		await manager.waitForAll();
		expect(manager.getRecentJobs()).toEqual([]);
		expect(manager.backgroundJob(promoted)).toBeTrue();
		expect(manager.getAllJobs().map(job => job.id)).toEqual([promoted]);
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(completions).toEqual([promoted]);
		await manager.dispose();
	});

	test("evicts a consumed settled row on the short grace instead of full retention", async () => {
		// A settled job whose result reached its consumer (sink delivery or a
		// foreground snapshot) must not linger in `hub jobs` reads for the full
		// 5-minute retention window — that lingering is the "background jobs
		// hang around after they complete" complaint. Delivery success marks
		// the result consumed, which re-arms eviction on the short grace.
		const manager = new AsyncJobManager({
			consumedResultEvictionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("bash", "delivered", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.isJobResultConsumed(jobId)).toBe(true);
		await waitForJobEviction(manager, jobId);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("keeps an unconsumed dead-lettered row inspectable until a snapshot consumes it", async () => {
		// No default sink and no owner sink: the delivery dead-letters, so the
		// result is never consumed. The row must outlive the consumed grace
		// (its result text is the only inspectable copy) and only evict once a
		// foreground snapshot consumes it. Fake timers drive the eviction
		// clocks deterministically — the survival half asserts an absence, which
		// polling cannot express.
		vi.useFakeTimers();
		try {
			const manager = new AsyncJobManager({
				retentionMs: 60_000,
				consumedResultEvictionMs: 25,
			});

			const jobId = manager.register("bash", "orphan", async () => "orphan result");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });

			vi.advanceTimersByTime(1_000);
			expect(manager.getJob(jobId)?.resultText).toBe("orphan result");

			expect(manager.consumeJobResults([jobId])).toBe(1);
			vi.advanceTimersByTime(25);
			expect(manager.getJob(jobId)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("keeps the consumed row while its async-result delivery is still parked", async () => {
		// Regression (autoreview): a foreground snapshot consuming a result
		// whose delivery is parked on the owner's yield queue must NOT arm the
		// short consumed grace. Evicting would clear the suppression marker
		// (#evictJob) before the queue's isStale check drains the parked entry,
		// letting the already-consumed result inject a duplicate async-result
		// follow-up once the tool batch settles. Fake timers prove the absence
		// of eviction past the consumed grace deterministically.
		vi.useFakeTimers();
		try {
			const gate = Promise.withResolvers<void>();
			const manager = new AsyncJobManager({ consumedResultEvictionMs: 25 });
			manager.registerDeliverySink("Main", async () => {
				await gate.promise; // parked async-result entry (receipt pending)
			});

			const jobId = manager.register("bash", "parked", async () => "done", { ownerId: "Main" });
			await manager.waitForAll();
			await waitForCondition(() => manager.getDeliveryState({ ownerId: "Main" }).delivering);

			// A foreground recovery read consumes the result mid-park.
			expect(manager.consumeJobResults([jobId])).toBe(1);
			vi.advanceTimersByTime(1_000);

			// Row and suppression marker both survive the consumed grace: the
			// parked entry's isStale check still resolves through the marker.
			expect(manager.getJob(jobId)?.status).toBe("completed");
			expect(manager.isDeliverySuppressed(jobId)).toBe(true);

			gate.resolve();
			await scheduler.yield();
			expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
			// Once the parked delivery settles, its suppression marker has served
			// its purpose and the already-consumed row starts the short grace.
			vi.advanceTimersByTime(25);
			expect(manager.getJob(jobId)).toBeUndefined();
			await manager.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		let completedJobId = "";
		const completedDelivered = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async jobId => {
				if (jobId === completedJobId) completedDelivered.resolve();
			},
		});

		completedJobId = manager.register("bash", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		await completedDelivered.promise;
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Promise.all([waitForJobEviction(manager, completedJobId), waitForJobEviction(manager, runningJobId)]);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let failedJobId = "";
		let attempts = 0;
		const sentinelDelivered = Promise.withResolvers<void>();
		const firstAttempt = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId !== failedJobId) {
					sentinelDelivered.resolve();
					return;
				}
				attempts += 1;
				firstAttempt.resolve();
				throw new Error("delivery failed");
			},
		});

		failedJobId = manager.register("bash", "awaited-job", async () => "done");
		await manager.waitForAll();

		await firstAttempt.promise;
		while (!manager.hasPendingDeliveries()) await scheduler.yield();

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([failedJobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		manager.register("bash", "sentinel-job", async () => "sentinel");
		await manager.waitForAll();
		await sentinelDelivered.promise;
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const drained = await manager.dispose({ timeoutMs: 25 });

		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("starts queued deliveries while an earlier sink receipt is pending", async () => {
		const releaseDeliveries = Promise.withResolvers<void>();
		const bothStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", async jobId => {
			started.push(jobId);
			if (started.length === 2) bothStarted.resolve();
			await releaseDeliveries.promise;
		});

		const firstId = manager.register("bash", "first", async () => "first result", { ownerId: "Main" });
		const secondId = manager.register("bash", "second", async () => "second result", { ownerId: "Main" });
		await manager.waitForAll();

		await bothStarted.promise;
		expect(started).toEqual([firstId, secondId]);

		releaseDeliveries.resolve();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const mainDeliveryFinished = Promise.withResolvers<void>();
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
			mainDeliveryFinished.resolve();
		});
		manager.registerDeliverySink("3-AuthLoader", (jobId, text) => {
			subagentCompletions.push({ jobId, text });
		});

		mainJobId = manager.register("bash", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("bash", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await mainDeliveryFinished.promise;
		await manager.dispose();
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", async jobId => {
			notifyTargetDeliveryStarted();
			await targetDeliveryReleased;
			completions.push(jobId);
		});

		manager.register("bash", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("bash", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("routes owned deliveries to the owner's registered sink only", async () => {
		const mainDeliveries: string[] = [];
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		manager.registerDeliverySink("Main", jobId => {
			mainDeliveries.push(jobId);
		});

		manager.register("bash", "owned", async () => "ok", { id: "owned-1", ownerId: "Main" });
		manager.register("bash", "unowned", async () => "ok", { id: "unowned-1" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(mainDeliveries).toEqual(["owned-1"]);
		expect(defaultDeliveries).toEqual(["unowned-1"]);
	});

	test("delivers a completion that settled while a wait watched it but returned something else", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			delivered.push(text);
		});
		const id = manager.register("bash", "EchoPeer", async () => "received=kestrel42", { ownerId: "Main" });
		manager.watchJobs([id]);
		await manager.getJob(id)?.promise;
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([]);

		// The wait returned a peer message instead of this job's result.
		manager.unwatchJobs([id]);
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["received=kestrel42"]);
	});

	test("dead-letters an owned delivery when its owner has no live sink", async () => {
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		const unregister = manager.registerDeliverySink("Sub", () => {});
		unregister();

		manager.register("bash", "orphan", async () => "orphan result", { id: "orphan-1", ownerId: "Sub" });
		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 500 });

		// Dead-letter drops the delivery (drain settles) without misrouting it
		// into the default sink; the outcome stays readable on the job row.
		expect(drained).toBe(true);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob("orphan-1")?.resultText).toBe("orphan result");
	});

	test("waitForOwnerJobs settles cancelled jobs and skips suppressed ones on request", async () => {
		const manager = new AsyncJobManager({});
		manager.register(
			"bash",
			"hung",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "stopped";
			},
			{ id: "hung-1", ownerId: "Sub" },
		);

		// Quiescence-barrier contract: a watched (suppressed) job can never
		// re-wake a run, so the filtered wait treats it as settled.
		manager.watchJobs(["hung-1"]);
		await expect(manager.waitForOwnerJobs("Sub", { excludeSuppressed: true })).resolves.toBe(true);

		// Teardown-reap contract: the unfiltered wait blocks until the
		// cancelled job's body actually finishes.
		const reap = manager.waitForOwnerJobs("Sub", { timeoutMs: 1_000 });
		manager.cancelAll({ ownerId: "Sub" });
		await expect(reap).resolves.toBe(true);
		expect(manager.getJob("hung-1")?.status).toBe("cancelled");
	});
});

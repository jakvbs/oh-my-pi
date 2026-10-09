import { describe, expect, it } from "bun:test";
import { buildCoordinationAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-tui/tools/task";

const item = (): TaskItem => ({ task: "do the thing" });

describe("buildCoordinationAdvisory", () => {
	it("suggests coordination when multiple siblings can message each other", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, true)).toBeDefined();
	});

	it("stays silent for a single spawn", () => {
		expect(buildCoordinationAdvisory([item()], true, true)).toBeUndefined();
	});

	it("stays silent when messaging is unavailable", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, false)).toBeUndefined();
	});

	it("stays silent without spawn capacity", () => {
		expect(buildCoordinationAdvisory([item(), item()], false, true)).toBeUndefined();
	});
});

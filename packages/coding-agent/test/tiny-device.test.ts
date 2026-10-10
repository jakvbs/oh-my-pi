import { describe, expect, it } from "bun:test";
import {
	normalizeTinyModelDevice,
	resolveTinyModelDevicePreference,
	TINY_MODEL_DEVICE_DEFAULT,
	type TinyOnnxDevice,
	tinyModelDeviceLoadOrder,
	tinyModelDeviceSettingToEnv,
} from "@oh-my-pi/pi-coding-agent/tiny/device";

describe("tiny model device selection", () => {
	it("defaults to CPU-only inference on every platform", () => {
		const preference = resolveTinyModelDevicePreference(undefined);

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
	});

	it("rejects the retired mlx and metal device values", () => {
		expect(() => normalizeTinyModelDevice("mlx")).toThrow("Unsupported PI_TINY_DEVICE");
		expect(() => normalizeTinyModelDevice("metal")).toThrow("Unsupported PI_TINY_DEVICE");
	});

	it("keeps webgpu off the macOS worker but usable elsewhere", () => {
		const expectedOrder: readonly TinyOnnxDevice[] = process.platform === "darwin" ? ["cpu"] : ["webgpu", "cpu"];
		expect(tinyModelDeviceLoadOrder(resolveTinyModelDevicePreference("webgpu"))).toEqual(expectedOrder);
	});

	it("keeps explicit CPU runs CPU-only", () => {
		const preference = resolveTinyModelDevicePreference(" cpu ");

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
	});

	it("rejects unknown ONNX execution providers", () => {
		expect(() => resolveTinyModelDevicePreference("neural-magic")).toThrow("Unsupported PI_TINY_DEVICE");
	});
});

describe("tiny model device setting → PI_TINY_DEVICE mapping", () => {
	it("returns undefined for the default sentinel so the worker keeps its CPU default", () => {
		expect(tinyModelDeviceSettingToEnv(TINY_MODEL_DEVICE_DEFAULT)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv(undefined)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv("")).toBeUndefined();
	});
});

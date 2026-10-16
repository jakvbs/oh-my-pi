import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Model, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { enforceStrictSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		...overrides,
	};
}

function toRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getDataSchema(parameters: Record<string, unknown>): Record<string, unknown> {
	return toRecord(toRecord(parameters.properties).data);
}

function makeCodexModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("YieldTool", () => {
	it("commits a terminal yield emitted before parent steering lands (#10645)", async () => {
		// The parent's `hub send` arrives while the child is still streaming its
		// yield call. The already-generated yield must execute and settle the
		// child instead of being skipped for the queued steer.
		const tool = new YieldTool(createSession());
		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "tool-yield-steering",
			name: "yield",
			arguments: { data: { report: "finished" } },
		};
		const mock = createMockModel({
			responses: [{ content: [yieldCall] }, { content: ["parent steering handled"] }],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			interruptMode: "immediate",
		});
		const events: AgentEvent[] = [];
		let steeringSent = false;
		const unsubscribe = agent.subscribe(event => {
			events.push(event);
			if (
				!steeringSent &&
				event.type === "message_update" &&
				event.message.role === "assistant" &&
				event.message.content.some(content => content.type === "toolCall" && content.name === "yield")
			) {
				steeringSent = true;
				agent.steer({
					role: "user",
					content: "Wrap up now with your findings.",
					attribution: "agent",
					timestamp: Date.now(),
				});
			}
		});

		await agent.prompt("start");
		unsubscribe();

		expect(steeringSent).toBe(true);
		const yieldEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === yieldCall.id,
		);
		expect(yieldEnd?.isError).toBe(false);
		expect(yieldEnd?.result.details).toEqual({ data: { report: "finished" }, status: "success", error: undefined });
	});

	it("accepts aborted payload with error only", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-2", { error: "blocked" } as never);
		expect(result.details).toEqual({ data: undefined, status: "aborted", error: "blocked" });
	});

	it("accepts typed success without data as a last-turn result", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-last-turn", { type: "summary" } as never);
		expect(result.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			useLastTurn: true,
		});
	});
	it("rejects a data-less useLastTurn finalize when the last turn carries no text", async () => {
		// Thinking-only final turn: `useLastTurn` extraction resolves to empty, so
		// finalization would fail the run post-mortem with a null-data warning and
		// no retry. The free-form analog of the schema guard bounces it in-band.
		const tool = new YieldTool(createSession({ getLastAssistantText: () => undefined }));
		await expect(tool.execute("call-empty-last-turn", { type: "result" } as never)).rejects.toThrow(
			/no text \(thinking only\)/,
		);
	});

	it("accepts a data-less useLastTurn finalize when the last turn has text", async () => {
		const tool = new YieldTool(createSession({ getLastAssistantText: () => "the actual answer" }));
		const result = await tool.execute("call-text-last-turn", { type: "result" } as never);
		expect(result.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			useLastTurn: true,
		});
	});

	it("aborts a persistently empty last-turn finalize instead of retrying forever", async () => {
		const tool = new YieldTool(createSession({ getLastAssistantText: () => undefined }));
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(tool.execute("call-empty-retry", { type: "result" } as never)).rejects.toThrow(
				/retries remaining before abort/,
			);
		}
		const aborted = await tool.execute("call-empty-final", { type: "result" } as never);
		expect(aborted.details?.status).toBe("aborted");
		expect(aborted.details?.error).toMatch(/empty last-turn result after \d+ consecutive attempt/);
	});

	it("parses JSON-string data when the schema rejects the string form", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { n: { type: "number" } },
					required: ["n"],
				},
			}),
		);
		const result = await tool.execute("call-string-data", { data: '{"n":4}' } as never);
		expect(result.details).toEqual({ data: { n: 4 }, status: "success", error: undefined });
	});

	it("arg validation serializes object payloads for string-typed output fields", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
				},
			}),
		);
		expect(
			validateToolArguments(tool as never, {
				type: "toolCall",
				id: "call-dict-summary",
				name: "yield",
				arguments: { data: { summary: { purge: 13, keep: 20 } } },
			}),
		).toEqual({ data: { summary: '{"purge":13,"keep":20}' } });
	});

	it("never drops the schema in strict mode, however many attempts fail", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: { properties: { answer: { type: "string" } } },
				outputSchemaMode: "strict",
			}),
		);
		for (let attempt = 1; attempt <= 5; attempt++) {
			await expect(tool.execute(`call-bad-${attempt}`, { data: { answer: attempt } })).rejects.toThrow(
				"Output does not match schema",
			);
		}
		const valid = await tool.execute("call-good", { data: { answer: "ok" } });
		expect(valid.details).toMatchObject({ data: { answer: "ok" }, status: "success", schemaOverridden: undefined });
	});

	it("rejects missing success data unless a yield type requests last-turn mode", async () => {
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-untyped-empty", {} as never)).rejects.toThrow(
			"yield must contain either `data` or `error`",
		);
		await expect(tool.execute("call-empty-type", { type: [] } as never)).rejects.toThrow("type must be a string");
		await expect(tool.execute("call-both", { data: { ok: true }, error: "boom" } as never)).rejects.toThrow(
			"yield cannot contain both data and error",
		);
		await expect(tool.execute("call-object-error", { error: { message: "boom" } } as never)).rejects.toThrow(
			"error must be a string",
		);
	});

	it("accepts data alongside empty or placeholder errors (non-strict OpenAI-compatible backends)", async () => {
		for (const error of ["", "   ", "unused", "n/a", "None", "  placeholder\n"]) {
			const tool = new YieldTool(createSession());
			const result = await tool.execute("call-placeholder-error", {
				type: "result",
				data: { ok: true },
				error,
			} as never);
			expect(result.details?.status).toBe("success");
			expect(result.details?.data).toEqual({ ok: true });
			expect(result.details?.error).toBeUndefined();
		}
	});

	it("treats a blank error without data as an empty result, but keeps filler text as an error-only failure reason", async () => {
		for (const error of ["", "   "]) {
			const tool = new YieldTool(createSession());
			await expect(tool.execute("call-blank-error-only", { error } as never)).rejects.toThrow(
				"yield must contain either `data` or `error`",
			);
		}
		const tool = new YieldTool(createSession());
		const unused = await tool.execute("call-unused-error-only", { error: "unused" } as never);
		expect(unused.details?.status).toBe("aborted");
		expect(unused.details?.error).toBe("unused");
		const padded = await tool.execute("call-padded-error-only", { error: "  boom\n" } as never);
		expect(padded.details?.error).toBe("boom");
	});

	it("rejects data alongside a real error with resend payloads that keep the type", async () => {
		const typed = await new YieldTool(createSession())
			.execute("call-conflict-typed", { type: "result", data: { ok: true }, error: "invalid output shape" } as never)
			.catch(err => err);
		expect(typed).toBeInstanceOf(Error);
		expect(String(typed.message)).toContain("yield cannot contain both data and error");
		expect(String(typed.message)).toContain('{"type":"result","data":<your output>}');
		expect(String(typed.message)).toContain('{"error":"invalid output shape"}');
	});

	it("aborts instead of throwing forever after repeated untyped empty results", async () => {
		const tool = new YieldTool(createSession());
		const expectedGuidance =
			'yield must contain either `data` or `error`. Submit success as {"data":<your output>} or failure as {"error":"message"}.';

		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-empty-retry-${attempt}`, {} as never)).rejects.toThrow(expectedGuidance);
		}

		const abortResult = await tool.execute("call-empty-abort", {} as never);
		const details = abortResult.details;
		if (!details) throw new Error("missing abort details");
		expect(details.status).toBe("aborted");
		expect(details.data).toBeUndefined();
		expect(String(details.error)).toContain("retrying forever");
		expect(abortResult.content).toEqual([{ type: "text", text: expect.stringContaining("Task aborted") }]);
	});

	it("resets the untyped empty-result retry budget after a valid yield", async () => {
		const tool = new YieldTool(createSession());
		const expectedGuidance =
			'yield must contain either `data` or `error`. Submit success as {"data":<your output>} or failure as {"error":"message"}.';

		for (let attempt = 1; attempt <= 2; attempt++) {
			await expect(tool.execute(`call-empty-before-valid-${attempt}`, {} as never)).rejects.toThrow(
				expectedGuidance,
			);
		}

		const validResult = await tool.execute("call-valid-reset", { data: { ok: true } } as never);
		expect(validResult.details).toEqual({ data: { ok: true }, status: "success", error: undefined });

		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-empty-after-valid-${attempt}`, {} as never)).rejects.toThrow(expectedGuidance);
		}

		const abortResult = await tool.execute("call-empty-after-reset-abort", {} as never);
		const details = abortResult.details;
		if (!details) throw new Error("missing abort details");
		expect(details.status).toBe("aborted");
		expect(details.data).toBeUndefined();
		expect(String(details.error)).toContain("retrying forever");
		expect(abortResult.content).toEqual([{ type: "text", text: expect.stringContaining("Task aborted") }]);
	});

	it("exposes typed last-turn mode in the argument schema", () => {
		const tool = new YieldTool(createSession());
		const parameters = tool.parameters as unknown as Record<string, unknown>;
		const typeSchema = toRecord(toRecord(parameters.properties).type);

		expect(typeSchema.type).toBe("string");

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		// A typed yield may omit data (last-turn extraction). The untyped empty-result
		// case is rejected at runtime by execute(), NOT the schema — a top-level
		// combinator expressing that constraint would break OpenAI/Codex strict mode.
		expect(
			validateToolArguments(toolDefinition, {
				type: "toolCall",
				id: "call-schema-typed",
				name: tool.name,
				arguments: { type: "summary" },
			}),
		).toEqual({ type: "summary" });
	});

	it("emits Codex-valid yield parameters: no top-level combinator under strict mode", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			}),
		);
		expect(tool.strict).toBe(true);

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: tool.strict,
		};
		const [converted] = convertOpenAICodexResponsesTools([toolDefinition], makeCodexModel());
		if (converted.type !== "function") throw new Error("expected a function tool payload");
		expect(converted.strict).toBe(true);

		const params = converted.parameters;
		expect(params.type).toBe("object");
		// OpenAI/Codex Responses reject a function whose parameters carry any of these
		// at the top level (the bug this guards against).
		for (const combinator of ["allOf", "anyOf", "oneOf", "enum", "const", "not"]) {
			expect(params[combinator]).toBeUndefined();
		}
		// Strict enforcement makes the optional `type`/`data`/`error` properties
		// required + nullable, so the model signals omission with `null`.
		const props = toRecord(params.properties);
		for (const name of ["type", "data", "error"]) {
			const prop = toRecord(props[name]);
			const variants = Array.isArray(prop.anyOf) ? prop.anyOf.map(toRecord) : [];
			expect(variants.some(variant => variant.type === "null")).toBe(true);
		}
	});

	it("treats strict-mode nulls as omitted arguments", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			}),
		);
		const result = await tool.execute("call-null-type", {
			type: null,
			data: { answer: "ok" },
			error: null,
		} as never);
		expect(result.details).toEqual({
			data: { answer: "ok" },
			status: "success",
			error: undefined,
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});

		const untyped = new YieldTool(createSession());
		const lastTurn = await untyped.execute("call-null-data", { type: "summary", data: null, error: null } as never);
		expect(lastTurn.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			useLastTurn: true,
		});
	});

	it("omits nested strict-mode null optionals while retaining explicit nullable values", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					properties: {
						status: { type: "string" },
						steps: {
							elements: {
								properties: { name: { type: "string" } },
								optionalProperties: {
									blocker: { type: "string" },
									blocker_details: { type: "string", nullable: true },
								},
							},
						},
					},
					optionalProperties: { landing_receipt: { type: "string" } },
				},
			}),
		);
		const result = await tool.execute("call-nested-optionals", {
			data: {
				status: "done",
				steps: [{ name: "completed", blocker: null, blocker_details: null }],
				landing_receipt: null,
			},
			error: null,
		});
		expect(result.details?.status).toBe("success");
		expect(result.details?.data).toEqual({
			status: "done",
			steps: [{ name: "completed", blocker_details: null }],
		});
		await expect(
			tool.execute("call-required-null", { data: { status: null, steps: [{ name: "completed" }] } }),
		).rejects.toThrow(/status: expected string, received null/);
	});

	it("omits optional nulls in strict prefixItems and trailing items without changing required fields", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						tuple: {
							type: "array",
							prefixItems: [
								{
									type: "object",
									properties: { id: { type: "string" }, note: { type: "string" } },
									required: ["id"],
									additionalProperties: false,
								},
							],
							items: {
								type: "object",
								properties: { label: { type: "string" }, note: { type: "string" } },
								required: ["label"],
								additionalProperties: false,
							},
							minItems: 2,
							maxItems: 2,
						},
					},
					required: ["tuple"],
					additionalProperties: false,
				},
			}),
		);
		expect(tool.strict).toBe(true);
		const result = await tool.execute("call-tuple", {
			data: {
				tuple: [
					{ id: "done", note: null },
					{ label: "next", note: null },
				],
			},
		});
		expect(result.details?.data).toEqual({ tuple: [{ id: "done" }, { label: "next" }] });
		await expect(
			tool.execute("call-tuple-required", { data: { tuple: [{ id: null }, { label: "next" }] } }),
		).rejects.toThrow(/tuple\/0\/id: expected string, received null/);
	});

	it("normalizes optional nulls inside JTD discriminator variants", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					discriminator: "kind",
					mapping: {
						done: {
							properties: { status: { type: "string" } },
							optionalProperties: { blocker: { type: "string" } },
						},
						blocked: { properties: { reason: { type: "string" } } },
					},
				},
			}),
		);
		const result = await tool.execute("call-variant-optional", {
			data: { kind: "done", status: "complete", blocker: null },
		});
		expect(result.details?.data).toEqual({ kind: "done", status: "complete" });
	});

	it("accepts arbitrary data when outputSchema is null", async () => {
		const tool = new YieldTool(createSession({ outputSchema: null }));
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-null", { data: { nested: { x: 1 }, ok: true } } as never);
		expect(result.details).toEqual({
			data: { nested: { x: 1 }, ok: true },
			status: "success",
			error: undefined,
		});
	});

	it("treats outputSchema true as unconstrained and accepts primitive and array data", async () => {
		const tool = new YieldTool(createSession({ outputSchema: true }));
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBeUndefined();
		const primitiveResult = await tool.execute("call-true-number", { data: 42 } as never);
		expect(primitiveResult.details).toEqual({ data: 42, status: "success", error: undefined });

		const arrayResult = await tool.execute("call-true-array", { data: ["ok", 1, false] } as never);
		expect(arrayResult.details).toEqual({
			data: ["ok", 1, false],
			status: "success",
			error: undefined,
		});
	});

	it("preserves explicit loose object output schemas and disables strict tool mode", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					additionalProperties: true,
				},
			}),
		);
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.additionalProperties).toBe(true);

		const result = await tool.execute("call-loose-object", {
			data: { nested: { x: 1 }, ok: true },
		} as never);
		expect(result.details).toEqual({ data: { nested: { x: 1 }, ok: true }, status: "success", error: undefined });
	});
	it("repairs strict schema generation for required-only object output schemas", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					required: ["data"],
				},
			}),
		);
		const strictParameters = enforceStrictSchema(tool.parameters as unknown as Record<string, unknown>);
		// Strict enforcement wraps the optional `data` as `anyOf: [T, null]`; inspect T.
		const nullable = getDataSchema(strictParameters);
		const dataSchema = toRecord(
			(Array.isArray(nullable.anyOf) ? nullable.anyOf : []).find(v => toRecord(v).type === "object"),
		);

		expect(tool.strict).toBe(true);
		expect(dataSchema.properties).toEqual({});
		expect(dataSchema.required).toEqual([]);
		expect(dataSchema.additionalProperties).toBe(false);
	});

	it("normalizes object/null type arrays into strict-compatible data variants", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: ["object", "null"],
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			}),
		);
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);
		expect(tool.strict).toBe(true);
		expect(Array.isArray(dataSchema.anyOf)).toBe(true);

		const variants = dataSchema.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(objectVariant).toBeDefined();
		expect((objectVariant as Record<string, unknown>).properties).toEqual({ name: { type: "string" } });
		expect((objectVariant as Record<string, unknown>).required).toEqual(["name"]);
		expect(nullVariant).toEqual({ type: "null" });
	});

	it("converts mixed JTD and JSON Schema output definitions into provider-valid schemas", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						results: {
							type: "array",
							elements: {
								properties: {
									issue: { type: "int32" },
								},
							},
						},
					},
					required: ["results"],
				},
			}),
		);
		const dataUnion = getDataSchema(tool.parameters as unknown as Record<string, unknown>);
		// `data` is now a section-variant union; the full-output object is the first branch.
		const dataSchema = toRecord(Array.isArray(dataUnion.anyOf) ? dataUnion.anyOf[0] : dataUnion);
		const resultsSchema = toRecord(toRecord(dataSchema.properties).results);
		const issueSchema = toRecord(toRecord(toRecord(resultsSchema.items).properties).issue);

		expect(resultsSchema.type).toBe("array");
		expect(resultsSchema.items).toBeDefined();
		expect(resultsSchema.elements).toBeUndefined();
		expect(issueSchema.type).toBe("integer");

		await expect(
			tool.execute("call-mixed-valid", { data: { results: [{ issue: 185 }] } } as never),
		).resolves.toBeDefined();
		await expect(
			tool.execute("call-mixed-invalid", { data: { results: [{ issue: "185" }] } } as never),
		).rejects.toThrow("Output does not match schema");
	});

	it("supports $defs/$ref output schemas by inlining definitions and degrades after first runtime failure", async () => {
		const outputSchema = {
			$defs: {
				A: {
					type: "object",
					properties: {
						kind: { const: "A" },
						token: { type: "string", minLength: 10 },
					},
					required: ["kind", "token"],
					additionalProperties: false,
				},
			},
			anyOf: [
				{ $ref: "#/$defs/A" },
				{
					type: "object",
					properties: {
						kind: { const: "B" },
						n: { type: "integer", minimum: 10 },
					},
					required: ["kind", "n"],
					additionalProperties: false,
				},
			],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const parametersRecord = tool.parameters as unknown as Record<string, unknown>;
		// $defs should NOT be in parameters — refs are inlined
		expect(parametersRecord.$defs).toBeUndefined();
		const dataSchema = getDataSchema(parametersRecord);
		// The inlined anyOf[0] should be the A definition (not a $ref)
		const anyOfVariants = dataSchema.anyOf as Array<Record<string, unknown>>;
		expect(anyOfVariants).toBeDefined();
		expect(anyOfVariants[0].$ref).toBeUndefined();
		expect(toRecord(anyOfVariants[0].properties).kind).toBeDefined();

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		const firstCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-1",
			name: tool.name,
			arguments: { data: { kind: "A", token: "x" } },
		};
		// validateToolArguments should succeed (no $ref to resolve)
		const firstArgs = validateToolArguments(toolDefinition, firstCall);
		// Runtime AJV still validates the original schema — token too short.
		// First MAX_SCHEMA_RETRIES (=3) invalid yields throw with a retry hint.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-ref-${attempt}`, firstArgs as never)).rejects.toThrow(
				"Output does not match schema",
			);
		}

		const overrideCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-override",
			name: tool.name,
			arguments: { data: { kind: "A", token: "x" } },
		};
		const overrideArgs = validateToolArguments(toolDefinition, overrideCall);
		const overrideResult = await tool.execute("call-ref-override", overrideArgs as never);
		expect(overrideResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 4 failed attempt(s)).",
			},
		]);
	});
	it("falls back to unconstrained object data when output schema is invalid", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						value: { type: "not-a-real-json-schema-type" },
					},
					required: ["value"],
				},
			}),
		);
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const dataSchemaProperties = toRecord(dataSchema.properties);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");
		expect(dataSchemaProperties.value).toBeUndefined();
		expect(Object.keys(dataSchemaProperties)).toHaveLength(0);

		const result = await tool.execute("call-invalid-schema", {
			data: { value: 123, nested: { ok: true } },
		} as never);
		expect(result.details).toEqual({
			data: { value: 123, nested: { ok: true } },
			status: "success",
			error: undefined,
		});
	});
	it("falls back to unconstrained data schema when output schema is circular", async () => {
		const circularSchema: Record<string, unknown> = { type: "object" };
		circularSchema.self = circularSchema;

		const tool = new YieldTool(createSession({ outputSchema: circularSchema }));
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-circular-schema", { data: { ok: true } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("falls back to unconstrained data schema when output schema is deeply nested", async () => {
		const buildDeepSchema = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {
				type: "object",
				properties: {},
				required: ["next"],
			};
			let current = root;

			for (let i = 0; i < depth; i++) {
				const next: Record<string, unknown> = {
					type: "object",
					properties: {},
					required: ["next"],
				};
				const currentProperties = toRecord(current.properties);
				currentProperties.next = next;
				current.properties = currentProperties;
				current = next;
			}

			current.properties = { value: { type: "string" } };
			current.required = ["value"];
			return root;
		};

		const tool = new YieldTool(createSession({ outputSchema: buildDeepSchema(20_000) }));
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-deep-schema", { data: { nested: true } } as never);
		expect(result.details).toEqual({ data: { nested: true }, status: "success", error: undefined });
	});

	it("handles non-object output schemas without blocking successful result submission", async () => {
		for (const outputSchema of [[], 123, false]) {
			const tool = new YieldTool(createSession({ outputSchema }));
			const result = await tool.execute("call-non-object-schema", {
				data: { value: outputSchema },
			} as never);
			expect(result.details).toEqual({
				data: { value: outputSchema },
				status: "success",
				error: undefined,
			});
		}
	});
	it("keeps runtime validation against the original output schema", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const dataSchema = getDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const tokenSchema = toRecord(toRecord(dataSchema.properties).token);

		expect(tokenSchema.minLength).toBeUndefined();
		await expect(tool.execute("call-short", { data: { token: "ab" } } as never)).rejects.toThrow(
			"Output does not match schema",
		);

		const result = await tool.execute("call-long", { data: { token: "abcd" } } as never);
		expect(result.details).toEqual({ data: { token: "abcd" }, status: "success", error: undefined });
	});

	it("retries on schema failures up to MAX_SCHEMA_RETRIES and overrides afterward", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		// First three invalid yields throw with retry guidance.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-short-${attempt}`, { data: { token: "ab" } } as never)).rejects.toThrow(
				"Output does not match schema",
			);
		}

		// Fourth invalid yield is accepted with override.
		const overrideResult = await tool.execute("call-short-override", {
			data: { token: "ab" },
		} as never);
		expect(overrideResult.details).toEqual({
			data: { token: "ab" },
			status: "success",
			error: undefined,
			schemaOverridden: true,
		});
		expect(overrideResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 4 failed attempt(s)).",
			},
		]);
	});

	it("keeps schema degradation counter at zero when submissions are valid", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		const firstResult = await tool.execute("call-valid-1", { data: { token: "abcd" } } as never);
		expect(firstResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		const secondResult = await tool.execute("call-valid-2", { data: { token: "abcde" } } as never);
		expect(secondResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		await expect(tool.execute("call-invalid-after-valid", { data: { token: "ab" } } as never)).rejects.toThrow(
			"Output does not match schema",
		);
	});

	it("rejects nested-array shape mismatches with a retry hint (scout-style JTD)", async () => {
		// Regression for the GLM/scout failure mode: model invents per-file fields
		// (`ref`, `surface`, …) instead of the schema's `path` + `description`. The
		// in-tool validator MUST surface the mismatch with a retry directive so the
		// subagent can fix its output before the parent runs its post-mortem check.
		const outputSchema = {
			properties: {
				summary: { type: "string" },
				files: {
					elements: {
						properties: {
							path: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const badPayload = {
			summary: "analysis",
			files: [
				{
					ref: "finding.md",
					surface: "gossip",
					auth: "pre-auth",
					allocation: "unbounded",
					mechanism: "loop",
				},
			],
		};

		await expect(tool.execute("call-scout-1", { data: badPayload } as never)).rejects.toThrow(
			/files\/0\/path: is required.*Call yield again with the corrected shape/,
		);

		// Third retry still throws with one attempt remaining advertised in the hint.
		await tool.execute("call-scout-2", { data: badPayload } as never).catch(() => {});
		await expect(tool.execute("call-scout-3", { data: badPayload } as never)).rejects.toThrow(
			"this is the final retry before the schema constraint is dropped",
		);
	});

	it("still throws structural errors after schema validation has been degraded", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		// Exhaust the schema-retry budget.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-struct-${attempt}`, { data: { token: "ab" } } as never)).rejects.toThrow(
				"Output does not match schema",
			);
		}
		await expect(tool.execute("call-struct-override", { data: { token: "ab" } } as never)).resolves.toBeDefined();

		// Structural errors (empty untyped submission) still throw even after override.
		await expect(tool.execute("call-struct-missing", {} as never)).rejects.toThrow(
			"yield must contain either `data` or `error`",
		);
	});
	it("falls back to loose schema when outputSchema contains unresolved external $ref", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						item: { $ref: "https://example.com/missing-schema.json" },
					},
					required: ["item"],
				},
			}),
		);
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-unresolved-ref", {
			data: { item: { whatever: true }, extra: 1 },
		} as never);
		expect(result.details).toEqual({
			data: { item: { whatever: true }, extra: 1 },
			status: "success",
			error: undefined,
		});
	});

	it("recovers double-encoded JSON primitives only when raw validation fails", async () => {
		const enumTool = new YieldTool(createSession({ outputSchema: { enum: ["correct", "incorrect"] } }));
		// Double-encoded enum: raw `"correct"` (with quotes) fails the enum,
		// decoded `correct` validates — adopted without spending retries twice.
		const recovered = await enumTool.execute("call-prim-enum", { data: '"correct"' } as never);
		expect(recovered.details?.data).toBe("correct");
		// Decoded-but-still-invalid stays rejected: `"still-wrong"` parses to
		// a string that still misses the enum.
		await expect(enumTool.execute("call-prim-bad", { data: '"still-wrong"' } as never)).rejects.toThrow(
			/Output does not match schema/,
		);
		// Decoded `null` stays rejected with a retryable error: finalization
		// treats null data as missing, so accepting it would warn post-mortem.
		await expect(enumTool.execute("call-prim-null", { data: "null" } as never)).rejects.toThrow(
			/Output does not match schema/,
		);

		const numberTool = new YieldTool(createSession({ outputSchema: { type: "number" } }));
		const recoveredNum = await numberTool.execute("call-prim-num", { data: "42" } as never);
		expect(recoveredNum.details?.data).toBe(42);
	});

	it("leaves raw-valid strings untouched by JSON recovery", async () => {
		const tool = new YieldTool(createSession({ outputSchema: { type: "string" } }));
		// `"42"` is already a valid string but also parses as JSON — recovery
		// must not run before raw validation and coerce it to `42`.
		const result = await tool.execute("call-raw-str", { data: "42" } as never);
		expect(result.details?.data).toBe("42");
	});

	it("does not treat literal $ref fields inside enum values as unresolved schema references", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					enum: [{ $ref: "literal" }],
				},
			}),
		);

		// Object-valued enums cannot be reduced to a single `type` keyword, so
		// strict mode falls back to non-strict — that's the strict-mode
		// contract, separately exercised in `schema-strict-mode.test.ts`. What
		// this test guards is that the literal `$ref: "literal"` inside the
		// enum value is treated as opaque data (not mistaken for an unresolved
		// schema reference that would discard the enum entirely).
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-literal-ref-enum", {
			data: { $ref: "literal" },
		} as never);
		expect(result.details?.data).toEqual({ $ref: "literal" });
		await expect(
			tool.execute("call-invalid-literal-ref-enum", {
				data: { $ref: "different" },
			} as never),
		).rejects.toThrow("Output does not match schema");
	});
});

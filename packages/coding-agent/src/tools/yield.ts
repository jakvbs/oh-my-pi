/**
 * Result submission tool for structured-output sessions (SDK embedders): the session ends its
 * run by submitting `data` or an `error`.
 */
import type {
	AgentMessage,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { prompt } from "@oh-my-pi/pi-utils";
import yieldDescription from "../prompts/tools/yield.md" with { type: "text" };
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

const YIELD_FORMAT_HINT = 'Submit success as {"data":<your output>} or failure as {"error":"message"}.';

export function resolveYieldReportText(messages: readonly AgentMessage[], toolCallId: string): string | undefined {
	const current = messages.at(-1);
	if (current?.role !== "assistant" || ["error", "aborted", "length"].includes(current.stopReason)) return;
	const calls = current.content.filter(block => block.type === "toolCall");
	if (calls.length !== 1 || calls[0].name !== "yield" || calls[0].id !== toolCallId) return;
	const currentText = current.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
	if (currentText.trim()) return currentText;
	for (let index = messages.length - 2; index >= 0; index--) {
		const previous = messages[index];
		if (previous.role === "developer") {
			const blocks =
				typeof previous.content === "string" ? [{ type: "text", text: previous.content }] : previous.content;
			if (
				blocks.length &&
				blocks.every(block => block.type === "text" && block.text.startsWith("<system-reminder>"))
			)
				continue;
		}
		if (
			previous.role !== "assistant" ||
			previous.stopReason !== "stop" ||
			previous.content.some(block => block.type === "toolCall")
		)
			return;
		const text = previous.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return text.trim() ? text : undefined;
	}
}

export interface YieldDetails {
	/** Successful result payload, or omitted when `useLastTurn` requests last-turn extraction. */
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	/** True when the caller intentionally omitted success data so the run's last assistant turn is the result. */
	useLastTurn?: boolean;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the run's
	 * post-mortem validation can honor the override instead of re-rejecting the
	 * same payload with `schema_violation`.
	 */
	schemaOverridden?: boolean;
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

const yieldTypeSchema: Record<string, unknown> = {
	type: "string",
	description: 'Optional. Pass "result" without `data` to submit your last assistant turn as the result.',
};

function parseYieldType(value: unknown): string | undefined {
	// Strict-mode providers (OpenAI/Codex) make the optional `type` property
	// required+nullable, so an untyped final yield arrives as `type: null`.
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	throw new Error("type must be a string");
}
/** Parse any JSON-encoded string value (`"correct"`, `42`, `{"n":4}` …).
 * Returns a `{parsed:true,value}` sentinel — never `undefined`-as-failure —
 * so decoded `null`/`false` stay distinguishable from a parse error.
 * Runs only after raw validation already failed, and the caller adopts the
 * value only if it revalidates. */
function parseJsonEncodedValue(value: string): { parsed: true; value: unknown } | { parsed: false } {
	try {
		return { parsed: true, value: JSON.parse(value) };
	} catch {
		return { parsed: false };
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the optional `error` argument. Strict-mode providers (OpenAI/Codex) send
 * omitted optionals as `null`; non-strict OpenAI-compatible backends routinely
 * fill the optional string with `""` next to a valid `data` payload. Both mean
 * "no error" — an empty string is never a usable failure reason.
 */
function parseYieldError(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") return value;
	throw new Error("error must be a string");
}

function buildYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	// `data` xor `error`, and "omitted data requires a `type`", are enforced in
	// `execute()` at runtime, NOT in this schema: a top-level combinator
	// (`allOf`/`anyOf`/`oneOf`/...) makes OpenAI/Codex Responses reject the whole
	// tool with `invalid_function_parameters`, so the parameters stay a plain
	// object with optional properties (strict enforcement makes them nullable).
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			type: yieldTypeSchema,
			data: dataSchema,
			error: { type: "string", description: "Failure reason; mutually exclusive with data" },
		},
		required: [],
	};
}

/**
 * Max consecutive schema-validation failures before the yield tool overrides validation
 * and lets non-conforming data through; never in `outputSchemaMode: "strict"`. The override is a safety net for schemas the
 * JTD→JSON-Schema converter cannot fully express; it should not be reached during normal
 * model retries. Three matches the existing "3 reminders" pattern elsewhere in the agent
 * runtime.
 */
const MAX_SCHEMA_RETRIES = 3;

/**
 * Max consecutive untyped empty-result submissions before the yield tool fails
 * the child explicitly. Some weak tool callers can acknowledge the required
 * shape in prose while repeatedly sending `{}`; without a hard stop the parent
 * waits forever.
 */
const MAX_EMPTY_RESULT_RETRIES = 3;

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "Submit Result";
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	readonly #normalizeData?: (value: unknown) => unknown;
	#schemaStrict = true;
	#schemaValidationFailures = 0;
	#emptyResultFailures = 0;
	readonly #session: ToolSession;
	readonly #parameters: TSchema;

	get strict(): boolean {
		return this.#schemaStrict;
	}

	get description(): string {
		return prompt.render(yieldDescription, {
			hasOutputSchema: this.#validate !== undefined,
		});
	}

	get parameters(): TSchema {
		return this.#parameters;
	}

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let normalizeData: ((value: unknown) => unknown) | undefined;
		let parameters: TSchema;

		try {
			const {
				validator,
				jsonSchema: normalizedSchema,
				normalized,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			if (validator) {
				validate = value => validator.validate(value);
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (!schemaError && normalizedSchema !== undefined) {
				const strictProbe = tryEnforceStrictSchema(normalizedSchema);
				if (strictProbe.strict) {
					if (validator) {
						normalizeData = value => validator.normalize(value);
					}
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedSchema);
				} else {
					sanitizedSchema = normalizedSchema;
					this.#schemaStrict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.#schemaStrict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("schema contains unresolved $ref after dereferencing");
				}
				dataSchema = resolved;
			} else {
				this.#schemaStrict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = buildYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = buildYieldParameters(
				looseRecordSchema(`Structured JSON output (schema processing failed: ${errorMsg})`),
			);
			validate = undefined;
			normalizeData = undefined;
			this.#schemaStrict = false;
		}

		this.#session = session;
		this.#validate = validate;
		this.#normalizeData = normalizeData;
		this.#parameters = parameters;
	}

	/**
	 * Clear per-run retry counters before a kept-alive session continues with a new
	 * monitored turn. The tool instance is stored once in the session's tool registry and
	 * reused across follow-up turns, so a prior run's counters would otherwise leak forward.
	 */
	resetTurnState(): void {
		this.#schemaValidationFailures = 0;
		this.#emptyResultFailures = 0;
	}

	async execute(
		toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		if (!isPlainRecord(params)) throw new Error("yield arguments must be an object");
		const raw = params;
		const yieldType = parseYieldType(raw.type);
		// Strict-mode providers send omitted optionals as `null`; treat it as absent.
		let data: unknown = raw.data === null ? undefined : raw.data;
		const errorMessage = parseYieldError(raw.error);
		let useLastTurn = errorMessage === undefined && data === undefined && yieldType !== undefined;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("yield cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined && yieldType === undefined) {
			this.#emptyResultFailures++;
			if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
				const attemptCount = this.#emptyResultFailures;
				this.#emptyResultFailures = 0;
				const error = `yield result stayed empty after ${attemptCount} consecutive attempt(s); aborting instead of retrying forever. ${YIELD_FORMAT_HINT}`;
				return {
					content: [{ type: "text", text: `Task aborted: ${error}` }],
					details: { data: undefined, status: "aborted", error },
				};
			}
			const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
			throw new Error(
				`yield must contain either \`data\` or \`error\`. ${YIELD_FORMAT_HINT} Empty untyped result retries remaining before abort: ${remaining}.`,
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		let schemaValidationFailureCount = 0;
		// A schema-bound last-turn yield can only submit raw prose, which the run's post-mortem
		// validation would reject as a fatal schema_violation the session can no longer correct.
		// Catch it here as a retryable error instead.
		if (status === "success" && useLastTurn && this.#validate) {
			throw new Error(
				"This task requires structured output matching the declared schema; a last-turn result cannot satisfy it. " +
					`Submit the full object: {"data":<object matching the schema>}.`,
			);
		}
		// A data-less `useLastTurn` yield resolves to the last assistant turn's text. A
		// thinking-only turn carries none, so accepting it would record an empty result that the
		// run's post-mortem validation fails after the session can no longer correct it. Reject at
		// the boundary so the reminder ladder re-prompts for `data`.
		if (
			status === "success" &&
			useLastTurn &&
			(this.#session.getLastAssistantText !== undefined || this.#session.getYieldReportText !== undefined)
		) {
			const resolveReport = this.#session.getYieldReportText;
			const lastTurnText = resolveReport ? resolveReport(toolCallId) : this.#session.getLastAssistantText?.();
			if (lastTurnText === undefined || lastTurnText.trim().length === 0) {
				this.#emptyResultFailures++;
				if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
					const attemptCount = this.#emptyResultFailures;
					this.#emptyResultFailures = 0;
					const error = `yield resolved to an empty last-turn result after ${attemptCount} consecutive attempt(s); aborting instead of retrying forever. ${YIELD_FORMAT_HINT}`;
					return {
						content: [{ type: "text", text: `Task aborted: ${error}` }],
						details: { data: undefined, status: "aborted", error },
					};
				}
				const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
				throw new Error(
					`yield used the last assistant turn as the result, but that turn contains no text (thinking only). ` +
						`Put your result in \`data\`: ${YIELD_FORMAT_HINT} Empty last-turn result retries remaining before abort: ${remaining}.`,
				);
			}
			if (resolveReport) {
				data = lastTurnText;
				useLastTurn = false;
			}
		}
		const normalizeData = (value: unknown): unknown => this.#normalizeData?.(value) ?? value;
		if (status === "success" && data !== undefined) data = normalizeData(data);
		if (status === "success" && !useLastTurn) {
			const validateData = (value: unknown): JsonSchemaValidationResult | undefined =>
				this.#validate ? this.#validate(value) : undefined;
			let failure = validateData(data);
			if (failure && !failure.success && typeof data === "string") {
				// Lossless recovery: a JSON-encoded payload string parses to exactly
				// the intended value. Never the reverse — stringifying objects to
				// fit string-typed fields is silent corruption. The sentinel keeps
				// decoded `false` distinct from a parse error. Decoded `null` is
				// never adopted: the run treats null data as missing, so accepting
				// it here would report success and then fail post-mortem instead of
				// giving a retryable error.
				const decoded = parseJsonEncodedValue(data);
				if (decoded.parsed && decoded.value !== null) {
					const normalized = normalizeData(decoded.value);
					const revalidated = validateData(normalized);
					if (revalidated === undefined || revalidated.success) {
						data = normalized;
						failure = revalidated;
					}
				}
			}
			if (failure && !failure.success) {
				this.#schemaValidationFailures++;
				// Strict mode promises callers schema-valid data: the run has no later stage that
				// would reject an overridden payload.
				const strict = this.#session.outputSchemaMode === "strict";
				if (strict || this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
					const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
					const retryHint = strict
						? " Call yield again with the corrected shape; the schema stays enforced."
						: remaining > 0
							? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
							: " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
					throw new Error(
						`Output does not match schema: ${formatAllValidationIssues(failure.issues)}.${retryHint}`,
					);
				}
				// Budget exhausted: capture the count for the message, accept, and
				// reset so the next independent submission starts fresh.
				schemaValidationFailureCount = this.#schemaValidationFailures;
				this.#schemaValidationFailures = 0;
				schemaValidationOverridden = true;
			} else {
				// Schema-valid submission: the documented budget is consecutive.
				this.#schemaValidationFailures = 0;
			}
		}

		this.#emptyResultFailures = 0;
		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${schemaValidationFailureCount} failed attempt(s)).`
					: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				useLastTurn: useLastTurn || undefined,
				schemaOverridden: schemaValidationOverridden || undefined,
			},
		};
	}
}
interface TurnStateResettable {
	resetTurnState(): void;
}

function canResetTurnState(tool: AgentTool): tool is AgentTool & TurnStateResettable {
	return "resetTurnState" in tool && typeof tool.resetTurnState === "function";
}

/**
 * Reset per-run yield state through either a native tool or an
 * `ExtensionToolWrapper` proxy.
 */
export function resetYieldTurnState(tool: AgentTool | undefined): void {
	if (tool && canResetTurnState(tool)) tool.resetTurnState();
}

/**
 * Normalizes the RPC wire bundle (JSON Schema 2020-12 + `x-rpc`) into a small
 * type model for the TypeScript emitter.
 */
import type { RpcWireBundle, RpcWireCommand } from "../../src/modes/rpc/wire";

/** A wire type reference or inline shape. */
export type WireType =
	| { kind: "string" | "integer" | "number" | "boolean" | "null" | "unknown" }
	| { kind: "literal"; value: string | number | boolean }
	| { kind: "enum"; values: string[] }
	| { kind: "ref"; name: string }
	| { kind: "array"; items: WireType }
	| { kind: "record"; values: WireType }
	| { kind: "union"; members: WireType[] };

/** One property of an object definition. */
export interface WireField {
	/** Wire key. */
	key: string;
	type: WireType;
	/** Must be present on the wire. */
	required: boolean;
	/** Decoders substitute this when the key is absent; `hasDefault` distinguishes a `null` default. */
	hasDefault: boolean;
	default?: unknown;
	doc?: string;
	/** `x-unknown-fallback`: a value that fails to decode becomes an unknown notification. */
	unknownFallback?: boolean;
	/** `x-scalar-or-array`: an array field older servers sent as a bare scalar. */
	scalarOrArray?: boolean;
}

/** A named definition. */
export type WireDef =
	| {
			name: string;
			doc?: string;
			kind: "object";
			fields: WireField[];
			/** Open record (`x-open`): decoders check the discriminator and keep every key. */
			open: boolean;
	  }
	| { name: string; doc?: string; kind: "alias"; type: WireType };

export interface WireModel {
	defs: Map<string, WireDef>;
	commands: RpcWireCommand[];
	notification: string;
	sessionEvent: string;
	serverFrame: string;
	inbound: string;
}

type JsonSchema = Record<string, unknown>;

const REF_PREFIX = "#/$defs/";

function parseType(schema: JsonSchema, where: string): WireType {
	if (typeof schema.$ref === "string") {
		if (!schema.$ref.startsWith(REF_PREFIX)) throw new Error(`${where}: unsupported $ref ${schema.$ref}`);
		return { kind: "ref", name: schema.$ref.slice(REF_PREFIX.length) };
	}
	if ("const" in schema) {
		const value = schema.const;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			throw new Error(`${where}: unsupported const`);
		}
		return { kind: "literal", value };
	}
	if (Array.isArray(schema.enum)) {
		if (!schema.enum.every(value => typeof value === "string")) throw new Error(`${where}: non-string enum`);
		return { kind: "enum", values: schema.enum as string[] };
	}
	if (Array.isArray(schema.anyOf)) {
		return {
			kind: "union",
			members: (schema.anyOf as JsonSchema[]).map((member, index) => parseType(member, `${where}|${index}`)),
		};
	}
	switch (schema.type) {
		case "string":
		case "integer":
		case "number":
		case "boolean":
		case "null":
			return { kind: schema.type };
		case "array":
			if (schema.prefixItems) throw new Error(`${where}: tuples are not supported on the wire`);
			return { kind: "array", items: parseType((schema.items ?? {}) as JsonSchema, `${where}[]`) };
		case "object": {
			const properties = (schema.properties ?? {}) as JsonSchema;
			if (Object.keys(properties).length > 0) {
				throw new Error(`${where}: inline objects must be named definitions`);
			}
			return { kind: "record", values: parseType((schema.additionalProperties ?? {}) as JsonSchema, `${where}{}`) };
		}
		case undefined:
			if (Object.keys(schema).every(key => key === "description" || key === "default")) return { kind: "unknown" };
	}
	throw new Error(`${where}: unsupported schema ${JSON.stringify(schema)}`);
}

function parseDef(name: string, schema: JsonSchema): WireDef {
	const doc = typeof schema.description === "string" ? schema.description : undefined;
	const properties = schema.properties as Record<string, JsonSchema> | undefined;
	if (schema.type === "object" && properties && Object.keys(properties).length > 0) {
		const required = new Set((schema.required ?? []) as string[]);
		const fields: WireField[] = [];
		for (const key in properties) {
			const property = properties[key];
			fields.push({
				key,
				type: parseType(property, `${name}.${key}`),
				required: required.has(key),
				hasDefault: "default" in property,
				default: property.default,
				doc: typeof property.description === "string" ? property.description : undefined,
				unknownFallback: property["x-unknown-fallback"] === true,
				scalarOrArray: property["x-scalar-or-array"] === true,
			});
		}
		return { name, doc, kind: "object", fields, open: schema["x-open"] === true };
	}
	return { name, doc, kind: "alias", type: parseType(schema, name) };
}

/** Builds the emitter model; throws on schema constructs no emitter supports. */
export function buildWireModel(bundle: RpcWireBundle): WireModel {
	const defs = new Map<string, WireDef>();
	for (const name in bundle.$defs) defs.set(name, parseDef(name, bundle.$defs[name]));
	return {
		defs,
		commands: bundle["x-rpc"].commands,
		notification: bundle["x-rpc"].notification,
		sessionEvent: bundle["x-rpc"].sessionEvent,
		serverFrame: bundle["x-rpc"].serverFrame,
		inbound: bundle["x-rpc"].inbound,
	};
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const SKIP = new Set(["tools.json", "remaining-tools.json"]);

export type McpJsonSchema = {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

let cache: Map<string, McpJsonSchema> | undefined;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: false });

export function mcpSchemaDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../schemas/mcp"),
    join(process.cwd(), "schemas/mcp"),
    join(process.cwd(), "../../schemas/mcp"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "get_capabilities.json"))) return dir;
  }
  throw new Error("schemas/mcp not found");
}

export function loadMcpSchemas(): Map<string, McpJsonSchema> {
  if (cache) return cache;
  const map = new Map<string, McpJsonSchema>();
  for (const name of readdirSync(mcpSchemaDir())) {
    if (!name.endsWith(".json") || SKIP.has(name)) continue;
    const schema = JSON.parse(readFileSync(join(mcpSchemaDir(), name), "utf8")) as McpJsonSchema;
    map.set(schema.title ?? name.replace(/\.json$/, ""), schema);
  }
  cache = map;
  return map;
}

export function publicInputSchema(tool: string): Record<string, unknown> {
  const schema = loadMcpSchemas().get(tool);
  if (!schema) {
    return { type: "object", additionalProperties: false, properties: {} };
  }
  const { $schema: _s, $id: _id, title: _t, ...rest } = schema;
  return {
    type: rest.type ?? "object",
    ...(rest.description ? { description: rest.description } : {}),
    ...(rest.properties ? { properties: rest.properties } : {}),
    ...(rest.required ? { required: rest.required } : {}),
    ...(rest.additionalProperties !== undefined ? { additionalProperties: rest.additionalProperties } : {}),
  };
}

export function validateToolArguments(tool: string, args: unknown): { ok: true } | { ok: false; message: string } {
  const schema = loadMcpSchemas().get(tool);
  if (!schema) {
    return { ok: false, message: "INVALID_ARGUMENT: unknown tool schema" };
  }
  const validate = ajv.compile(schema);
  if (validate(args ?? {})) return { ok: true };
  const first = validate.errors?.[0];
  const path = first?.instancePath || first?.schemaPath || "";
  return { ok: false, message: `INVALID_ARGUMENT: ${first?.message ?? "arguments rejected"}${path ? ` (${path})` : ""}` };
}

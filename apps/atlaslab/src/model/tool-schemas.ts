import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../ids.js";
import { PUBLIC_MCP_TOOLS, type PublicMcpTool } from "../types.js";

const SKIP_SCHEMA_FILES = new Set(["tools.json", "remaining-tools.json"]);

export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ParsedToolCall {
  id?: string;
  tool: string;
  arguments: Record<string, unknown>;
}

interface McpJsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

let schemaCache: Map<string, McpJsonSchema> | undefined;

function mcpSchemaDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../schemas/mcp"),
    join(process.cwd(), "schemas/mcp"),
    join(process.cwd(), "../../schemas/mcp"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "get_capabilities.json"))) return dir;
  }
  throw new Error("schemas/mcp not found");
}

function loadSchemas(): Map<string, McpJsonSchema> {
  if (schemaCache) return schemaCache;
  const dir = mcpSchemaDir();
  const map = new Map<string, McpJsonSchema>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || SKIP_SCHEMA_FILES.has(name)) continue;
    const schema = JSON.parse(readFileSync(join(dir, name), "utf8")) as McpJsonSchema;
    const tool = schema.title ?? name.replace(/\.json$/, "");
    map.set(tool, schema);
  }
  schemaCache = map;
  return map;
}

const HOST_INJECTED_ARG_FIELDS = new Set([
  "session_id",
  "cart_id",
  "expected_cart_version",
  "expected_session_context_version",
  "merchant_order_id",
  "evaluation_arm",
  "strategy_allowlist",
]);

export function modelVisibleToolSchema(tool: PublicMcpTool): Record<string, unknown> {
  const schema = compactToolSchema(tool);
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  let required = Array.isArray(schema.required) ? [...(schema.required as string[])] : undefined;
  for (const field of HOST_INJECTED_ARG_FIELDS) {
    delete properties[field];
  }
  required = required?.filter((field) => !HOST_INJECTED_ARG_FIELDS.has(field));
  if (tool === "complete_checkout") {
    delete properties.checkout_authority;
    required = required?.filter((field) => field !== "checkout_authority");
  }
  const { required: _ignored, ...rest } = schema;
  return {
    ...rest,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

export function compactToolSchema(tool: PublicMcpTool): Record<string, unknown> {
  const schema = loadSchemas().get(tool);
  if (!schema) {
    return { type: "object", properties: {} };
  }
  const { $schema: _s, $id: _id, title: _t, description, ...rest } = schema;
  return {
    type: rest.type ?? "object",
    description: description ?? _t ?? tool,
    properties: rest.properties ?? {},
    ...(rest.required ? { required: rest.required } : {}),
    ...(rest.additionalProperties !== undefined ? { additionalProperties: rest.additionalProperties } : {}),
  };
}

export function openAiToolsFor(allowed: PublicMcpTool[]): OpenAiFunctionTool[] {
  return allowed.filter((name) => (PUBLIC_MCP_TOOLS as readonly string[]).includes(name)).map((name) => {
    const visible = modelVisibleToolSchema(name);
    const { description: visibleDescription, ...visibleParameters } = visible;
    return {
      type: "function",
      function: {
        name,
        description: String(visibleDescription ?? name),
        parameters: {
          type: "object",
          ...visibleParameters,
        },
      },
    };
  });
}

export function canonicalModelId(id: string): string {
  const noProvider = (id.split("@")[0] ?? id).trim();
  return noProvider.replace(/^openrouter\//i, "").replace(/:(nitro|floor|extended|free|online|exacto|thinking)$/i, "");
}

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function parseToolCallFromContent(content: string): ParsedToolCall | undefined {
  if (!content.trim()) return undefined;
  const unfenced = content.replace(/```(?:json)?/gi, "```");
  const fence = unfenced.match(/```\s*([\s\S]*?)```/);
  const blobs = [fence?.[1]?.trim(), extractFirstJsonObject(content), content.trim()].filter(
    (item): item is string => Boolean(item),
  );
  for (const blob of blobs) {
    const obj = tryParseJson(blob);
    if (!obj) continue;
    const tool = String(obj.tool ?? obj.tool_name ?? obj.name ?? "").trim();
    if (!tool) continue;
    const rawArgs = obj.arguments ?? obj.parameters ?? obj.input ?? {};
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    return { tool, arguments: args };
  }
  return undefined;
}

export function parseNativeToolCall(
  toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }> | undefined,
): ParsedToolCall | undefined {
  const raw = toolCalls?.[0];
  const fn = raw?.function;
  if (!fn?.name) return undefined;
  let args: Record<string, unknown> = {};
  if (typeof fn.arguments === "string") {
    args = tryParseJson(fn.arguments) ?? {};
  } else if (fn.arguments && typeof fn.arguments === "object") {
    args = fn.arguments as Record<string, unknown>;
  }
  return { id: raw?.id, tool: fn.name, arguments: args };
}

export function usdToMicros(cost: number): number {
  if (!Number.isFinite(cost) || cost < 0) return 0;
  return Math.round(cost * 1_000_000);
}

export function toolSchemaDigest(): string {
  const schemas = Object.fromEntries(PUBLIC_MCP_TOOLS.map((tool) => [tool, modelVisibleToolSchema(tool)]));
  return sha256Hex(canonicalize(schemas));
}

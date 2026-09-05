import { newPrefixedId } from "../ids.js";
import type { AtlasLabConfig } from "../config.js";

export interface RawMcpTrace {
  tool: string;
  arguments: Record<string, unknown>;
  result_code: string;
  payload: Record<string, unknown>;
}

export async function rawMcpCall(opts: {
  mcpUrl: string;
  hostBearer: string;
  tool: string;
  arguments?: Record<string, unknown>;
  includeProof?: boolean;
}): Promise<RawMcpTrace> {
  const requestId = newPrefixedId("req");
  const meta: Record<string, unknown> = { request_id: requestId };
  if (opts.includeProof) meta.host_request_proof = "not-a-real-proof";
  const response = await fetch(opts.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.hostBearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: opts.tool,
        arguments: opts.arguments ?? {},
        _meta: { "com.atlas/request": meta },
      },
    }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = { error: { message: `HTTP ${response.status}` } };
  }
  const rpcError = json.error as { message?: string; code?: unknown } | undefined;
  if (rpcError) {
    const message = String(rpcError.message ?? "MCP_ERROR");
    const named = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
    return { tool: opts.tool, arguments: opts.arguments ?? {}, result_code: named ?? "MCP_ERROR", payload: json };
  }
  const rpcResult = (json.result as Record<string, unknown> | undefined) ?? json;
  const result =
    (rpcResult.structuredContent as Record<string, unknown> | undefined) ??
    (rpcResult.result as Record<string, unknown> | undefined) ??
    rpcResult;
  return {
    tool: opts.tool,
    arguments: opts.arguments ?? {},
    result_code: String(result.result_code ?? (response.ok ? "OK" : "TRANSPORT_ERROR")),
    payload: result,
  };
}

export function atlasOriginFromCfg(cfg: AtlasLabConfig): string {
  const u = new URL(cfg.mcpUrl);
  return `${u.protocol}//${u.host}`;
}

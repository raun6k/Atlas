import { FORBIDDEN_INTERNAL_PATHS, FORBIDDEN_INTERNAL_TOOLS, LabError, MUTATING_TOOLS, PUBLIC_MCP_TOOLS, type PublicMcpTool, type PublicState } from "../types.js";
import { redactUnknown } from "../redaction.js";

export interface McpCallRequest {
  tool: string;
  arguments: Record<string, unknown>;
  requestId: string;
  idempotencyKey?: string;
  hostRequestProof?: string;
  checkoutAuthority?: string;
  hostBearer: string;
}

export interface McpCallResult {
  ok: boolean;
  resultCode: string;
  retryable: boolean;
  payload: Record<string, unknown>;
  publicStatePatch: PublicState;
  requestId: string;
}

export interface McpClient {
  call(req: McpCallRequest): Promise<McpCallResult>;
}

const FORBIDDEN_URL_HINTS = [...FORBIDDEN_INTERNAL_PATHS, ":9090", "/test/v1/fixtures"];

export function assertPublicTool(tool: string): asserts tool is PublicMcpTool {
  if ((FORBIDDEN_INTERNAL_TOOLS as readonly string[]).includes(tool)) {
    throw new LabError("FORBIDDEN_INTERNAL_ACCESS", `${tool} is not a public MCP tool`, 403);
  }
  if (!(PUBLIC_MCP_TOOLS as readonly string[]).includes(tool)) {
    throw new LabError("UNKNOWN_TOOL", `tool ${tool} is not on atlas.merchant.v1`);
  }
}

export function assertPublicMcpTarget(url: string): void {
  const lower = url.toLowerCase();
  for (const hint of FORBIDDEN_URL_HINTS) {
    if (hint === "/test/v1/fixtures") continue;
    if (lower.includes(hint.replace(/\/$/, ""))) {
      throw new LabError("FORBIDDEN_INTERNAL_ACCESS", "AtlasLab MCP client cannot target internal Atlas surfaces", 403);
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new LabError("FORBIDDEN_INTERNAL_ACCESS", "MCP URL must be HTTP(S) public transport", 403);
  }
}

export function metadataFor(req: McpCallRequest): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    request_id: req.requestId,
  };
  if (req.idempotencyKey) meta.idempotency_key = req.idempotencyKey;
  if (req.hostRequestProof) meta.host_request_proof = "[REDACTED]";
  return { "com.atlas/request": meta };
}

export class HttpMcpClient implements McpClient {
  constructor(
    private readonly mcpUrl: string,
    private readonly extraSecrets: string[] = [],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertPublicMcpTarget(mcpUrl);
  }

  async call(req: McpCallRequest): Promise<McpCallResult> {
    assertPublicTool(req.tool);
    assertPublicMcpTarget(this.mcpUrl);
    const mutating = MUTATING_TOOLS.has(req.tool as PublicMcpTool);
    if (mutating && !req.hostRequestProof) {
      throw new LabError("HOST_PROOF_REQUIRED", "mutating tools require Host Request Proof");
    }
    const body = {
      jsonrpc: "2.0",
      id: req.requestId,
      method: "tools/call",
      params: {
        name: req.tool,
        arguments: req.arguments,
        _meta: {
          "com.atlas/request": {
            request_id: req.requestId,
            ...(req.idempotencyKey ? { idempotency_key: req.idempotencyKey } : {}),
            ...(req.hostRequestProof ? { host_request_proof: req.hostRequestProof } : {}),
          },
        },
      },
    };
    const response = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.hostBearer}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    const safe = redactUnknown(json, this.extraSecrets) as Record<string, unknown>;
    const rpcError = safe.error as { code?: number | string; message?: string; data?: unknown } | undefined;
    if (rpcError) {
      const message = String(rpcError.message ?? "MCP tool call failed");
      const named = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
      const resultCode = named ?? "MCP_ERROR";
      return {
        ok: false,
        resultCode,
        retryable: false,
        payload: { error: { code: rpcError.code ?? -32000, message, data: rpcError.data } },
        publicStatePatch: {},
        requestId: String(safe.id ?? req.requestId),
      };
    }
    const rpcResult = (safe.result as Record<string, unknown> | undefined) ?? safe;
    const result =
      (rpcResult.structuredContent as Record<string, unknown> | undefined) ??
      (rpcResult.result as Record<string, unknown> | undefined) ??
      rpcResult;
    const resultCode = String(result.result_code ?? (response.ok ? "OK" : "TRANSPORT_ERROR"));
    return {
      ok: response.ok && resultCode === "OK",
      resultCode,
      retryable: Boolean(result.retryable),
      payload: result,
      publicStatePatch: (result.public_state as PublicState) ?? {},
      requestId: String(result.request_id ?? req.requestId),
    };
  }
}

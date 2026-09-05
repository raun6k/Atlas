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
  correlation?: Record<string, string>;
  abort?: AbortSignal;
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
  if (req.correlation) meta.correlation = req.correlation;
  return { "com.atlas/request": meta };
}

export function resultCodeFromMcpError(message: string, data?: unknown): string {
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(code)) return code;
  }
  const named = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
  if (named && named !== "MCP") return named;
  const lower = message.toLowerCase();
  if (lower.includes("stale cart version")) return "CART_VERSION_CONFLICT";
  if (lower.includes("proposal is not active") || lower.includes("proposal expired")) return "REQUOTE_REQUIRED";
  return "MCP_ERROR";
}

function publicStateFromErrorData(data: unknown): PublicState {
  if (!data || typeof data !== "object") return {};
  const rec = data as Record<string, unknown>;
  const cart = (rec.current_cart ?? rec.currentCart) as Record<string, unknown> | undefined;
  const session = (rec.current_session_summary ?? rec.currentSessionSummary) as Record<string, unknown> | undefined;
  const patch: PublicState = {};
  const cartVersion = cart?.cart_version ?? cart?.cartVersion ?? rec.cart_version;
  if (cartVersion != null && cartVersion !== "") patch.cart_version = Number(cartVersion);
  const sessionId = session?.session_id ?? session?.sessionId;
  if (typeof sessionId === "string") patch.session_id = sessionId;
  const cartId = cart?.cart_id ?? cart?.cartId ?? session?.cart_id;
  if (typeof cartId === "string") patch.cart_id = cartId;
  return patch;
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
            ...(req.correlation ? { correlation: req.correlation } : {}),
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
      signal: req.abort,
    });
    const json = (await response.json()) as Record<string, unknown>;
    const safe = redactUnknown(json, this.extraSecrets) as Record<string, unknown>;
    const rpcError = safe.error as { code?: number | string; message?: string; data?: unknown } | undefined;
    if (rpcError) {
      const message = String(rpcError.message ?? "MCP tool call failed");
      const resultCode = resultCodeFromMcpError(message, rpcError.data);
      return {
        ok: false,
        resultCode,
        retryable: false,
        payload: { error: { code: rpcError.code ?? -32000, message, data: rpcError.data } },
        publicStatePatch: publicStateFromErrorData(rpcError.data),
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

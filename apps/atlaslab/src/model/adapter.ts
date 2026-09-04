import { redactUnknown, SECRET_CANARIES } from "../redaction.js";
import { LabError, type PublicMcpTool } from "../types.js";
import { newPrefixedId } from "../ids.js";
import {
  canonicalModelId,
  openAiToolsFor,
  parseNativeToolCall,
  parseToolCallFromContent,
  usdToMicros,
} from "./tool-schemas.js";

export interface ModelTurnRequest {
  requestedModelId: string;
  systemPrompt: string;
  snapshot: Record<string, unknown>;
  skill: string;
  temperature: number;
  maxTokens: number;
  allowedTools?: PublicMcpTool[];
  history?: ModelHistoryItem[];
}

export interface ModelHistoryItem {
  assistantContent: string;
  toolCall: { id: string; tool: string; arguments: Record<string, unknown> };
  toolResult: Record<string, unknown>;
}

export interface ModelTurnResponse {
  requestedModelId: string;
  returnedModelId: string;
  provider?: string;
  content: string;
  toolCall?: { id?: string; tool: string; arguments: Record<string, unknown> };
  visibleDecisionSummary: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsdMicros: number;
  latencyMs: number;
}

export interface ModelAdapter {
  complete(req: ModelTurnRequest): Promise<ModelTurnResponse>;
}

export class MockModelAdapter implements ModelAdapter {
  constructor(
    private readonly script: Array<Partial<ModelTurnResponse> & { tool?: string; arguments?: Record<string, unknown> }> = [],
    private readonly forceReturnedModel?: string,
  ) {}

  async complete(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const next = this.script.shift() ?? {};
    const returnedModelId = this.forceReturnedModel ?? next.returnedModelId ?? req.requestedModelId;
    if (canonicalModelId(returnedModelId) !== canonicalModelId(req.requestedModelId)) {
      throw new LabError("MODEL_ID_MISMATCH", `returned ${returnedModelId} != requested ${req.requestedModelId}`);
    }
    const tool = next.tool ?? next.toolCall?.tool;
    const args = next.arguments ?? next.toolCall?.arguments ?? {};
    const visible = next.visibleDecisionSummary ?? next.content ?? "No model-visible decision explanation was returned";
    const content = next.content ?? visible;
    const parsed = tool ? { tool, arguments: args } : parseToolCallFromContent(content);
    return {
      requestedModelId: req.requestedModelId,
      returnedModelId,
      provider: next.provider ?? "mock",
      content,
      toolCall: parsed,
      visibleDecisionSummary: visible,
      usage: next.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      costUsdMicros: next.costUsdMicros ?? 1000,
      latencyMs: next.latencyMs ?? 5,
    };
  }
}

export class OpenRouterAdapter implements ModelAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    if (!this.apiKey) throw new LabError("MODEL_UNAVAILABLE", "OpenRouter is not configured");
    const started = Date.now();
    const allowed = req.allowedTools ?? (Array.isArray(req.snapshot.allowed_tools) ? (req.snapshot.allowed_tools as PublicMcpTool[]) : []);
    const snapshot = { ...req.snapshot, selected_skill: req.skill };
    const tools = openAiToolsFor(allowed);
    const history = (req.history ?? []).flatMap((item) => [
      {
        role: "assistant",
        content: item.assistantContent,
        tool_calls: [
          {
            id: item.toolCall.id,
            type: "function",
            function: { name: item.toolCall.tool, arguments: JSON.stringify(item.toolCall.arguments) },
          },
        ],
      },
      { role: "tool", tool_call_id: item.toolCall.id, content: JSON.stringify(item.toolResult) },
    ]);
    const isGlm = /^z-ai\/glm-/i.test(req.requestedModelId);
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.requestedModelId,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        seed: 0,
        // Every AtlasLab model round is an action round until a terminal
        // assertion holds. Requiring a tool prevents provider-specific empty
        // reasoning-only messages from being mistaken for a buyer decision.
        tool_choice: tools.length > 0 ? "required" : "none",
        usage: { include: true },
        provider: { allow_fallbacks: true },
        ...(isGlm ? { reasoning: { effort: "high", exclude: true } } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        messages: [
          { role: "system", content: req.systemPrompt },
          ...history,
          { role: "user", content: JSON.stringify(snapshot) },
        ],
      }),
    });
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new LabError("MODEL_ERROR", `OpenRouter returned non-JSON (HTTP ${res.status})`);
    }
    const safe = redactUnknown(json, [this.apiKey, SECRET_CANARIES.OPENROUTER]) as Record<string, unknown>;
    if (!res.ok || safe.error) {
      const err = safe.error as { message?: string } | string | undefined;
      const message = typeof err === "string" ? err : err?.message ?? `OpenRouter HTTP ${res.status}`;
      throw new LabError("MODEL_ERROR", message);
    }
    const returnedRaw = safe.model == null || safe.model === "" ? req.requestedModelId : String(safe.model);
    if (canonicalModelId(returnedRaw) !== canonicalModelId(req.requestedModelId)) {
      throw new LabError("MODEL_ID_MISMATCH", `returned ${returnedRaw} != requested ${req.requestedModelId}`);
    }
    const choices = safe.choices as
      | Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
          };
        }>
      | undefined;
    const message = choices?.[0]?.message;
    const usage =
      (safe.usage as {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
        total_cost?: number;
      } | undefined) ?? {};
    const content = typeof message?.content === "string" ? message.content : "";
    const toolCall = parseNativeToolCall(message?.tool_calls) ?? parseToolCallFromContent(content);
    const costUsd = typeof usage.cost === "number" ? usage.cost : typeof usage.total_cost === "number" ? usage.total_cost : 0;
    return {
      requestedModelId: req.requestedModelId,
      returnedModelId: returnedRaw,
      provider: typeof safe.provider === "string" ? safe.provider : "openrouter",
      content,
      toolCall,
      visibleDecisionSummary: content || "No model-visible decision explanation was returned",
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
      costUsdMicros: usdToMicros(costUsd),
      latencyMs: Date.now() - started,
    };
  }
}

export function invocationId(): string {
  return newPrefixedId("miv");
}

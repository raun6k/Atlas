import { newPrefixedId } from "../ids.js";
import type { LabStore } from "../db/store.js";
import type { HostBoundary } from "../host/boundary.js";
import {
  LabError,
  type ConsentPolicy,
  type ModelDriverConfiguration,
  type PublicMcpTool,
  type PublicState,
  type RunRecord,
  type ScenarioDefinition,
} from "../types.js";
import { applyResultToState, enrichPublicToolArgs, persistProjection } from "../driver/projector.js";
import { progressAssertionsHold, type AssertionEvidence } from "../evaluator/evaluate.js";
import { argumentDigest } from "../host/signer.js";
import { redactUnknown } from "../redaction.js";
import { invocationId, type ModelAdapter, type ModelHistoryItem } from "./adapter.js";
import {
  allowedToolsForSkill,
  buildSnapshot,
  instructionsForSkill,
  selectSkill,
  snapshotDigest,
  SYSTEM_PROMPT,
  type LastActionSummary,
} from "./skills.js";

export interface SkillLoopResult {
  publicState: PublicState;
  terminalCode: string;
  failed?: string;
  returnedModelId?: string;
}

function commerceFingerprint(state: PublicState): string {
  return JSON.stringify({
    session_id: state.session_id ?? null,
    cart_id: state.cart_id ?? null,
    cart_version: state.cart_version ?? null,
    payment_status: state.payment_status ?? null,
  });
}

function summarizeToolResult(tool: string, result: { resultCode: string; payload: Record<string, unknown>; publicStatePatch: PublicState }): string {
  return JSON.stringify({
    tool,
    result_code: result.resultCode,
    session_id: result.publicStatePatch.session_id ?? result.payload.session_id,
    cart_id: result.publicStatePatch.cart_id ?? result.payload.cart_id,
    payment_capabilities: result.payload.payment_capabilities ?? result.publicStatePatch.payment_capabilities,
  }).slice(0, 1500);
}

export class SkillLoop {
  constructor(
    private readonly store: LabStore,
    private readonly host: HostBoundary,
    private readonly adapter: ModelAdapter,
  ) {}

  async run(opts: {
    run: RunRecord;
    model: ModelDriverConfiguration;
    consent: ConsentPolicy;
    permittedActions: PublicMcpTool[];
    mission: string;
    extraSecrets: string[];
    deadlineMs: number;
    scenario?: ScenarioDefinition;
  }): Promise<SkillLoopResult> {
    let state: PublicState = {};
    let tokens = 0;
    let cost = 0;
    let toolCalls = 0;
    let returnedModelId: string | undefined;
    let lastAction: LastActionSummary | undefined;
    let emptyActions = 0;
    let stallKey = "";
    let stallCount = 0;
    const history: ModelHistoryItem[] = [];
    const maxTurns = Math.min(opts.model.max_turns, 24);
    const maxTools = Math.min(opts.model.max_tool_calls, 40);

    const evidence = async (): Promise<AssertionEvidence> => ({
      state,
      exchanges: await this.store.listToolExchanges(opts.run.run_id),
      events: await this.store.listEvents(opts.run.run_id),
      consent: opts.consent,
    });

    const missionComplete = async (): Promise<boolean> =>
      progressAssertionsHold(opts.scenario?.required_terminal_assertions, await evidence());

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (Date.now() > opts.deadlineMs) {
        return { publicState: state, terminalCode: "RUN_BUDGET_EXHAUSTED", failed: "wall", returnedModelId };
      }
      const skill = selectSkill(state, turn);
      const skillTools = allowedToolsForSkill(skill, Boolean(state.effectful_payment_frozen));
      const allowed = skillTools.filter((t) => opts.permittedActions.includes(t));
      const snapshot = buildSnapshot({
        runId: opts.run.run_id,
        runType: opts.run.run_type,
        scenarioId: opts.run.scenario_id,
        arm: opts.run.arm,
        turn,
        skill,
        mission: opts.mission,
        consent: opts.consent,
        state,
        lastAction,
        remaining: {
          turns: maxTurns - turn + 1,
          tool_calls: maxTools - toolCalls,
          tokens: opts.model.token_ceiling - tokens,
          cost_usd_micros: opts.model.cost_ceiling_usd_micros - cost,
          buyer_spend_minor: opts.consent.max_amount_minor,
        },
        allowedTools: allowed,
      });
      const digest = snapshotDigest(snapshot);
      let response;
      try {
        response = await this.adapter.complete({
          requestedModelId: opts.model.model_id,
          systemPrompt: `${SYSTEM_PROMPT}\n\n# Active skill: ${skill}\n${instructionsForSkill(skill)}`,
          snapshot,
          skill,
          temperature: opts.model.temperature,
          maxTokens: opts.model.max_tokens_per_turn,
          allowedTools: allowed,
          history,
        });
      } catch (err) {
        const code = err instanceof LabError ? err.code : "MODEL_ERROR";
        await this.store.appendEvent({
          run_id: opts.run.run_id,
          source: "MODEL_VISIBLE",
          kind: code,
          payload: { turn, code },
        });
        return { publicState: state, terminalCode: code, failed: code, returnedModelId };
      }
      returnedModelId = response.returnedModelId;
      tokens += response.usage.total_tokens;
      cost += response.costUsdMicros;
      if (tokens > opts.model.token_ceiling || cost > opts.model.cost_ceiling_usd_micros) {
        await this.store.appendEvent({
          run_id: opts.run.run_id,
          source: "ATLASLAB_ORCHESTRATOR",
          kind: "RUN_BUDGET_EXHAUSTED",
          payload: { tokens, cost_usd_micros: cost },
        });
        return { publicState: state, terminalCode: "RUN_BUDGET_EXHAUSTED", failed: "tokens_or_cost", returnedModelId };
      }
      const invId = invocationId();
      await this.store.insertModelInvocation({
        invocation_id: invId,
        run_id: opts.run.run_id,
        requested_model_id: response.requestedModelId,
        returned_model_id: response.returnedModelId,
        configuration: {
          temperature: opts.model.temperature,
          skill_registry_version: opts.model.skill_registry_version,
          system_prompt_version: opts.model.system_prompt_version,
        },
        usage: response.usage,
        cost_usd_micros: response.costUsdMicros,
        latency_ms: response.latencyMs,
        outcome: "OK",
      });
      const visible = response.visibleDecisionSummary || "No model-visible decision explanation was returned";
      await this.store.appendEvent({
        run_id: opts.run.run_id,
        source: "MODEL_VISIBLE",
        kind: "MODEL_TURN",
        payload: { turn, skill, visible_decision_summary: visible, invocation_id: invId },
      });
      await this.store.insertAgentTurn({
        agent_turn_id: newPrefixedId("trn"),
        run_id: opts.run.run_id,
        turn_number: turn,
        snapshot_digest: digest,
        selected_skill: skill,
        invocation_id: invId,
        structured_action: response.toolCall ?? null,
        visible_decision_summary: visible,
      });

      if (!response.toolCall) {
        if (state.payment_status === "CAPTURED_RECONCILED" || state.payment_status === "FAILED_VERIFIED") {
          return { publicState: state, terminalCode: state.payment_status, returnedModelId };
        }
        if (await missionComplete()) {
          return { publicState: state, terminalCode: state.last_result_code ?? "OK", returnedModelId };
        }
        emptyActions += 1;
        lastAction = { no_structured_action: true, summary: visible };
        await this.store.appendEvent({
          run_id: opts.run.run_id,
          source: "MODEL_VISIBLE",
          kind: "NO_STRUCTURED_ACTION",
          payload: { turn, visible_decision_summary: visible },
        });
        if (emptyActions >= 2) {
          return { publicState: state, terminalCode: "NO_STRUCTURED_ACTION", failed: "NO_STRUCTURED_ACTION", returnedModelId };
        }
        continue;
      }
      emptyActions = 0;
      if (toolCalls + 1 > maxTools) {
        return { publicState: state, terminalCode: "RUN_BUDGET_EXHAUSTED", failed: "tools", returnedModelId };
      }
      toolCalls += 1;
      if (!allowed.includes(response.toolCall.tool as PublicMcpTool)) {
        await this.store.appendEvent({
          run_id: opts.run.run_id,
          source: "HOST_BOUNDARY",
          kind: "SIGNER_REJECTED",
          payload: { tool: response.toolCall.tool, reason: "tool not permitted for selected skill" },
        });
        lastAction = {
          tool: response.toolCall.tool,
          result_code: "SIGNER_REJECTED",
          summary: "tool not permitted for selected skill",
        };
        history.push({
          assistantContent: response.content,
          toolCall: {
            id: response.toolCall.id ?? `call_${turn}`,
            tool: response.toolCall.tool,
            arguments: response.toolCall.arguments,
          },
          toolResult: { result_code: "SIGNER_REJECTED", message: "tool not permitted for selected skill" },
        });
        continue;
      }
      const argumentsEnriched = enrichPublicToolArgs({
        tool: response.toolCall.tool,
        args: response.toolCall.arguments,
        state,
        runId: opts.run.run_id,
        mission: opts.mission,
      });
      const before = commerceFingerprint(state);
      const result = await this.host.invoke({
        run: opts.run,
        tool: response.toolCall.tool,
        arguments: argumentsEnriched,
        proposedBy: "MODEL_VISIBLE",
        permittedActions: opts.permittedActions,
        consent: opts.consent,
        publicState: state,
        extraSecrets: opts.extraSecrets,
      });
      state = applyResultToState(state, result);
      await persistProjection(this.store, opts.run.run_id, state);
      history.push({
        assistantContent: response.content,
          toolCall: {
            id: response.toolCall.id ?? `call_${turn}`,
            tool: response.toolCall.tool,
            arguments: response.toolCall.arguments,
        },
        toolResult: redactUnknown(
          { result_code: result.resultCode, ...result.payload },
          opts.extraSecrets,
        ) as Record<string, unknown>,
      });
      lastAction = {
        tool: response.toolCall.tool,
        result_code: result.resultCode,
        summary: summarizeToolResult(response.toolCall.tool, result),
      };
      const key = `${response.toolCall.tool}:${argumentDigest(argumentsEnriched)}`;
      if (key === stallKey && commerceFingerprint(state) === before) {
        stallCount += 1;
      } else {
        stallKey = key;
        stallCount = 1;
      }
      if (stallCount >= 3) {
        await this.store.appendEvent({
          run_id: opts.run.run_id,
          source: "ATLASLAB_ORCHESTRATOR",
          kind: "NO_PROGRESS",
          payload: { tool: response.toolCall.tool, repeats: stallCount },
        });
        return { publicState: state, terminalCode: "NO_PROGRESS", failed: "NO_PROGRESS", returnedModelId };
      }
      if (state.payment_status === "CAPTURED_RECONCILED" || state.payment_status === "FAILED_VERIFIED") {
        return { publicState: state, terminalCode: state.payment_status, returnedModelId };
      }
      if (await missionComplete()) {
        return { publicState: state, terminalCode: state.last_result_code ?? "OK", returnedModelId };
      }
    }
    return { publicState: state, terminalCode: "RUN_BUDGET_EXHAUSTED", failed: "turns", returnedModelId };
  }
}

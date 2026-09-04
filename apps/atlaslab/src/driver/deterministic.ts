import { newPrefixedId } from "../ids.js";
import type { LabStore } from "../db/store.js";
import type { HostBoundary } from "../host/boundary.js";
import { LabError, type ActionProgram, type ActionStep, type ConsentPolicy, type PublicMcpTool, type PublicState, type RunRecord } from "../types.js";
import { applyResultToState, enrichPublicToolArgs, persistProjection, resolveArgumentRefs } from "./projector.js";

const MAX_ATTEMPTS = 3;
const MAX_BRANCHES = 8;

export interface DeterministicDriverResult {
  publicState: PublicState;
  terminalCode: string;
  failed?: string;
}

export class DeterministicDriver {
  constructor(
    private readonly store: LabStore,
    private readonly host: HostBoundary,
  ) {}

  async run(opts: {
    run: RunRecord;
    program: ActionProgram;
    consent: ConsentPolicy;
    permittedActions: PublicMcpTool[];
    extraSecrets: string[];
    deadlineMs: number;
  }): Promise<DeterministicDriverResult> {
    if (opts.program.steps.length === 0) throw new LabError("INVALID_PROGRAM", "empty action program");
    if ((opts.program.max_branches ?? MAX_BRANCHES) > MAX_BRANCHES) {
      throw new LabError("INVALID_PROGRAM", "max_branches exceeds 8");
    }
    let state: PublicState = {};
    let stepId = opts.program.entry_step_id;
    let branches = 0;
    const byId = new Map(opts.program.steps.map((s) => [s.step_id, s]));

    while (stepId && stepId !== "TERMINAL") {
      if (Date.now() > opts.deadlineMs) {
        return { publicState: state, terminalCode: "FAILED_UNRESOLVED", failed: "deadline" };
      }
      const step = byId.get(stepId);
      if (!step) throw new LabError("INVALID_PROGRAM", `unknown step ${stepId}`);
      const outcome = await this.executeStep(opts, step, state);
      state = outcome.state;
      await persistProjection(this.store, opts.run.run_id, state);
      if (outcome.stop) {
        return { publicState: state, terminalCode: outcome.resultCode, failed: outcome.failed };
      }
      const next = step.next[outcome.resultCode] ?? step.next.default;
      if (next && next !== step.step_id && outcome.resultCode !== "OK") {
        branches += 1;
        if (branches > MAX_BRANCHES) {
          return { publicState: state, terminalCode: "FAILED", failed: "max_branches" };
        }
      }
      if (!next || next === "TERMINAL") {
        return { publicState: state, terminalCode: outcome.resultCode };
      }
      stepId = next;
    }
    return { publicState: state, terminalCode: state.last_result_code ?? "OK" };
  }

  private async executeStep(
    opts: {
      run: RunRecord;
      program: ActionProgram;
      consent: ConsentPolicy;
      permittedActions: PublicMcpTool[];
      extraSecrets: string[];
    },
    step: ActionStep,
    state: PublicState,
  ): Promise<{ state: PublicState; resultCode: string; stop?: boolean; failed?: string }> {
    const maxAttempts = Math.min(step.max_attempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS);
    let attempt = 0;
    let current = { ...state };
    const retainScope = `${opts.run.run_id}:${step.step_id}`;
    if (step.idempotency_rule === "retain") {
      this.host.retainKey(retainScope, this.host.keyFor(retainScope) ?? newPrefixedId("idem"));
    }

    while (attempt < maxAttempts) {
      attempt += 1;
      const args = enrichPublicToolArgs({
        tool: step.tool,
        args: resolveArgumentRefs(step.arguments, current),
        state: current,
        runId: opts.run.run_id,
      });

      await this.store.appendEvent({
        run_id: opts.run.run_id,
        source: "DETERMINISTIC_DRIVER",
        kind: "STEP_BEGIN",
        payload: { step_id: step.step_id, attempt, tool: step.tool, precondition: current },
      });

      try {
        const result = await this.host.invoke({
          run: opts.run,
          tool: step.tool,
          arguments: args,
          proposedBy: "DETERMINISTIC_DRIVER",
          idempotencyKey: step.idempotency_rule === "retain" ? this.host.keyFor(retainScope) : undefined,
          permittedActions: opts.permittedActions,
          consent: opts.consent,
          publicState: current,
          extraSecrets: opts.extraSecrets,
        });
        current = applyResultToState(current, result);
        await this.store.insertDriverStep({
          driver_step_id: newPrefixedId("dst"),
          run_id: opts.run.run_id,
          step_id: step.step_id,
          attempt,
          action_program_id: opts.program.action_program_id,
          public_precondition: { ...state },
          selected_branch: result.resultCode,
          typed_action: { tool: step.tool, arguments: args },
          result_code: result.resultCode,
          next_step_id: String(step.next[result.resultCode] ?? step.next.default ?? "TERMINAL"),
        });

        if (result.resultCode === "OUTCOME_UNKNOWN") {
          current.effectful_payment_frozen = true;
        }
        if (step.expected_result_codes.includes(result.resultCode) || result.resultCode === "OK") {
          return { state: current, resultCode: result.resultCode };
        }
        if (result.resultCode === "CART_VERSION_CONFLICT") {
          continue;
        }
        if (!step.expected_result_codes.includes(result.resultCode) && attempt >= maxAttempts) {
          return { state: current, resultCode: result.resultCode, stop: true, failed: result.resultCode };
        }
      } catch (err) {
        const code = err instanceof LabError ? err.code : "TRANSPORT_TIMEOUT";
        if (code === "TRANSPORT_TIMEOUT" && step.idempotency_rule === "retain") {
          continue;
        }
        if (attempt >= maxAttempts) {
          return { state: current, resultCode: code, stop: true, failed: code };
        }
      }
    }
    return { state: current, resultCode: current.last_result_code ?? "FAILED", stop: true, failed: "max_attempts" };
  }
}

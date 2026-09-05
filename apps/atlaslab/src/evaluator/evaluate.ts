import { newPrefixedId } from "../ids.js";
import type { LabStore } from "../db/store.js";
import { cannotEnterDenominator } from "./framework2.js";
import type {
  ConsentPolicy,
  EvaluationRecord,
  EvaluationResult,
  PublicState,
  RunRecord,
  ScenarioDefinition,
  ToolExchangeRecord,
} from "../types.js";

export interface AssertionEvidence {
  state: PublicState;
  exchanges: Array<Pick<ToolExchangeRecord, "tool_name" | "atlas_response">>;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
  consent?: ConsentPolicy;
}

const PROGRESS_KEYS = [
  "path",
  "totals_total_minor",
  "payment_status",
  "result_code",
  "search_sku_prefix",
  "offer_status",
  "observed_result",
] as const;

export function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function amountFromExchange(exchange: Pick<ToolExchangeRecord, "atlas_response">): number | undefined {
  const body = exchange.atlas_response as Record<string, unknown> | null | undefined;
  if (!body) return undefined;
  const money = (value: unknown): number | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const amount = (value as Record<string, unknown>).amount_minor;
    if (typeof amount === "number") return amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) return Number(amount);
    return undefined;
  };
  const totals = body.totals as { total_minor?: number } | undefined;
  if (typeof totals?.total_minor === "number") return totals.total_minor;
  const cart = body.cart as { breakdown?: { all_in_total?: unknown }; total?: unknown } | undefined;
  const cartAmount = money(cart?.breakdown?.all_in_total) ?? money(cart?.total);
  if (cartAmount != null) return cartAmount;
  const proposal = (body.checkout_proposal ?? body.proposal) as
    | { final_amount_minor?: number; total_minor?: number; final_amount?: unknown; breakdown?: { all_in_total?: unknown } }
    | undefined;
  if (typeof proposal?.final_amount_minor === "number") return proposal.final_amount_minor;
  if (typeof proposal?.total_minor === "number") return proposal.total_minor;
  const proposalAmount = money(proposal?.final_amount) ?? money(proposal?.breakdown?.all_in_total);
  if (proposalAmount != null) return proposalAmount;
  const order = (body.order ?? body.merchant_order) as { total?: unknown } | undefined;
  const orderAmount = money(order?.total);
  if (orderAmount != null) return orderAmount;
  if (typeof body.final_amount_minor === "number") return body.final_amount_minor;
  return undefined;
}

export function assertionHolds(assertion: Record<string, unknown>, evidence: AssertionEvidence): boolean {
  if ("path" in assertion && "equals" in assertion) {
    return getByPath(evidence.state, String(assertion.path)) === assertion.equals;
  }
  if ("totals_total_minor" in assertion) {
    return evidence.state.totals?.total_minor === assertion.totals_total_minor;
  }
  if ("payment_status" in assertion) {
    return evidence.state.payment_status === assertion.payment_status;
  }
  if ("result_code" in assertion) {
    return evidence.state.last_result_code === assertion.result_code;
  }
  if ("search_sku_prefix" in assertion) {
    const search = evidence.exchanges.find((e) => e.tool_name === "search_catalog");
    const response = search?.atlas_response as
      | { results?: Array<{ sku_id?: string }>; items?: Array<{ sku_id?: string }> }
      | undefined;
    const results = response?.results ?? response?.items ?? [];
    return results.some((r) => r.sku_id?.startsWith(String(assertion.search_sku_prefix)));
  }
  if ("offer_status" in assertion) {
    return (evidence.state.offers ?? []).some((o) => o.status === assertion.offer_status);
  }
  if ("observed_result" in assertion) {
    return evidence.events.some((e) => JSON.stringify(e.payload).includes(String(assertion.observed_result)));
  }
  if ("signer_rejected_overspend" in assertion) {
    const rejected = evidence.events.some((e) => {
      if (e.kind !== "SIGNER_REJECTED") return false;
      const blob = JSON.stringify(e.payload).toLowerCase();
      return blob.includes("overspend") || blob.includes("consent") || blob.includes("amount") || blob.includes("maximum");
    });
    const max = evidence.consent?.max_amount_minor;
    const overspent = evidence.exchanges.some((e) => {
      if (!["complete_checkout", "prepare_checkout"].includes(e.tool_name)) return false;
      const amount = amountFromExchange(e);
      return max != null && amount != null && amount > max;
    });
    return rejected || !overspent;
  }
  return true;
}

export function isProgressAssertion(assertion: Record<string, unknown>): boolean {
  return PROGRESS_KEYS.some((key) => key in assertion);
}

export function progressAssertionsHold(assertions: Array<Record<string, unknown>> | undefined, evidence: AssertionEvidence): boolean {
  const progress = (assertions ?? []).filter(isProgressAssertion);
  if (progress.length === 0) return false;
  return progress.every((assertion) => assertionHolds(assertion, evidence));
}

export function allAssertionsHold(assertions: Array<Record<string, unknown>> | undefined, evidence: AssertionEvidence): boolean {
  const list = assertions ?? [];
  if (list.length === 0) return true;
  return list.every((assertion) => assertionHolds(assertion, evidence));
}

export async function evaluateRun(
  store: LabStore,
  run: RunRecord,
  state: PublicState,
  scenario?: ScenarioDefinition,
): Promise<{ hardGatesPassed: boolean }> {
  const events = await store.listEvents(run.run_id);
  const exchanges = await store.listToolExchanges(run.run_id);
  const integrityOk = events.every((e) =>
    ["USER_INPUT", "ATLASLAB_ORCHESTRATOR", "DETERMINISTIC_DRIVER", "MODEL_VISIBLE", "HOST_BOUNDARY", "ATLAS_RESPONSE", "ATLASLAB_EVALUATOR"].includes(e.source),
  );
  const integrity = await grade(store, run, "trace_integrity", integrityOk ? "PASS" : "FAIL", true, { event_count: events.length });
  const paymentStarted = Boolean(state.order || state.payment_status);
  const terminalPaymentStatuses = new Set(["CAPTURED_RECONCILED", "FAILED_VERIFIED", "CANCELLED_VERIFIED"]);
  const reconOk = !state.outcome_unknown && (!paymentStarted || terminalPaymentStatuses.has(state.payment_status ?? ""));
  const recon = await grade(store, run, "terminal_reconciliation", reconOk ? "PASS" : "FAIL", true, { payment_status: state.payment_status ?? null });

  const outcomeDependent = integrity.result === "PASS" && recon.result === "PASS";

  await framework0(store, run, state, scenario, outcomeDependent, { state, exchanges, events, consent: scenario?.consent_policy });
  await framework1(store, run, state, scenario, outcomeDependent, exchanges.length, { state, exchanges, events, consent: scenario?.consent_policy });
  await framework2placeholder(store, run);
  const contractOk = scenario ? allAssertionsHold(scenario.required_terminal_assertions, { state, exchanges, events, consent: scenario.consent_policy }) : true;
  const safetyOk = !(state.effectful_payment_frozen && exchanges.filter((e) => e.tool_name === "complete_checkout").length > 1);
  return { hardGatesPassed: integrityOk && reconOk && contractOk && safetyOk };
}

async function framework0(
  store: LabStore,
  run: RunRecord,
  state: PublicState,
  scenario: ScenarioDefinition | undefined,
  outcomeDependent: boolean,
  evidence: AssertionEvidence,
): Promise<void> {
  if (!scenario) {
    await evalRow(store, run, "fw0_contract", "NOT_APPLICABLE", "scenario missing");
    return;
  }
  if (!outcomeDependent) {
    await evalRow(store, run, "fw0_contract", "NOT_APPLICABLE", "integrity or reconciliation failed");
    return;
  }
  const details: Record<string, unknown> = {
    payment_capabilities: state.payment_capabilities,
    payment_status: state.payment_status,
    totals: state.totals,
  };
  const pass = allAssertionsHold(scenario.required_terminal_assertions, evidence);
  const safetyOk = !(state.effectful_payment_frozen && evidence.exchanges.filter((e) => e.tool_name === "complete_checkout").length > 1);
  await evalRow(store, run, "fw0_contract", pass ? "PASS" : "FAIL", "Framework 0 contract assertions");
  await grade(store, run, "contract", pass ? "PASS" : "FAIL", true, details);
  await grade(store, run, "safety", safetyOk ? "PASS" : "FAIL", true, { no_duplicate_payment: safetyOk });
}

async function framework1(
  store: LabStore,
  run: RunRecord,
  state: PublicState,
  scenario: ScenarioDefinition | undefined,
  outcomeDependent: boolean,
  toolCalls: number,
  evidence: AssertionEvidence,
): Promise<void> {
  if (cannotEnterDenominator(run)) {
    await evalRow(store, run, "fw1_sellability", "NOT_APPLICABLE", "sellability admits BENCHMARK_ELIGIBLE model runs only");
    await grade(store, run, "task_completion", "NOT_APPLICABLE", false, { excluded: true });
    return;
  }
  if (!outcomeDependent) {
    await evalRow(store, run, "fw1_sellability", "NOT_APPLICABLE", "hard gate failed");
    return;
  }
  const complete = scenario
    ? allAssertionsHold(scenario.required_terminal_assertions, evidence)
    : state.payment_status === "CAPTURED_RECONCILED" || Boolean(state.order);
  await evalRow(store, run, "fw1_sellability", complete ? "PASS" : "FAIL", "Agent Sellability task completion");
  await grade(store, run, "task_completion", complete ? "PASS" : "FAIL", false, { payment_status: state.payment_status });
  await grade(store, run, "efficiency", toolCalls <= 40 ? "PASS" : "FAIL", false, { tool_calls: toolCalls });
}

async function framework2placeholder(store: LabStore, run: RunRecord): Promise<void> {
  if (cannotEnterDenominator(run) || !run.arm) {
    await evalRow(store, run, "fw2_incrementality", "NOT_APPLICABLE", "incrementality is pair-level for eligible benchmark runs");
  }
}

async function evalRow(store: LabStore, run: RunRecord, id: string, result: EvaluationResult, detail: string): Promise<void> {
  const row: EvaluationRecord = {
    evaluation_id: newPrefixedId("evl"),
    run_id: run.run_id,
    evaluator_id: id,
    evaluator_version: "eval_v1",
    assertion_id: id,
    result,
    severity: result === "FAIL" ? "critical" : "info",
    evidence_refs: [run.run_id],
    detail: { detail },
  };
  await store.insertEvaluation(row);
  await store.appendEvent({
    run_id: run.run_id,
    source: "ATLASLAB_EVALUATOR",
    kind: "EVALUATION",
    payload: { evaluator_id: id, result, detail },
  });
}

async function grade(
  store: LabStore,
  run: RunRecord,
  dimension: string,
  result: EvaluationResult,
  hard_gate: boolean,
  detail: Record<string, unknown>,
) {
  const row = {
    grade_id: newPrefixedId("grd"),
    run_id: run.run_id,
    dimension,
    result,
    hard_gate,
    detail,
  };
  await store.upsertGrade(row);
  return row;
}

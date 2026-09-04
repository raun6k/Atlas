import { newPrefixedId } from "../ids.js";
import { redactUnknown } from "../redaction.js";
import type { LabStore } from "../db/store.js";
import {
  PROOF_STAGES,
  type FailureDomain,
  type PaymentAssuranceProjection,
  type ProofStage,
  type PublicState,
  type RequirementCategory,
  type RunEventRecord,
  type RunFailure,
  type RunProof,
  type RunRecord,
  type RunRequirementGrade,
  type RunStageResult,
  type ScenarioDefinition,
  type StageResult,
  type ToolExchangeRecord,
  type TrajectoryStep,
} from "../types.js";
import { assertionHolds, type AssertionEvidence } from "./evaluate.js";

export function extractRevenueMinor(state?: PublicState | null): number | undefined {
  if (!state) return undefined;
  if (state.outcome_unknown) return undefined;
  if (state.payment_status !== "CAPTURED_RECONCILED") return undefined;
  if (typeof state.totals?.total_minor === "number") return state.totals.total_minor;
  const order = state.order as { total?: { amount_minor?: number }; total_minor?: number } | undefined;
  if (typeof order?.total_minor === "number") return order.total_minor;
  if (typeof order?.total?.amount_minor === "number") return order.total.amount_minor;
  return undefined;
}

function toolOk(exchanges: ToolExchangeRecord[], name: string): boolean {
  return exchanges.some((e) => e.tool_name === name && e.result_status !== "FAIL" && e.request_status !== "FAIL");
}

function offerInPlay(state: PublicState, scenario?: ScenarioDefinition): boolean {
  if ((state.offers ?? []).length > 0) return true;
  const assertions = scenario?.required_terminal_assertions ?? [];
  if (assertions.some((a) => "offer_status" in a)) return true;
  const req = scenario?.structured_requirements ?? {};
  if (req.offer || req.offers) return true;
  return false;
}

function stageFromTools(stage: ProofStage, exchanges: ToolExchangeRecord[], state: PublicState, scenario?: ScenarioDefinition): StageResult {
  switch (stage) {
    case "DISCOVERY":
      return toolOk(exchanges, "get_capabilities") || toolOk(exchanges, "create_session") ? "PASS" : "FAIL";
    case "CATALOG_RESOLUTION":
      return toolOk(exchanges, "search_catalog") || toolOk(exchanges, "get_product") ? "PASS" : "FAIL";
    case "CART_VALID":
      return (state.lines?.length ?? 0) > 0 || toolOk(exchanges, "add_cart_item") ? "PASS" : "FAIL";
    case "OFFER_DECISION":
      if (!offerInPlay(state, scenario)) return "NOT_APPLICABLE";
      if ((state.offers ?? []).some((o) => ["SHOWN", "ACCEPTED", "APPLIED"].includes(String(o.status ?? "")))) return "PASS";
      if (toolOk(exchanges, "accept_offer") || toolOk(exchanges, "apply_offer")) return "PASS";
      return "FAIL";
    case "QUOTE_HELD":
      return state.checkout_proposal || toolOk(exchanges, "prepare_checkout") ? "PASS" : "FAIL";
    case "CHECKOUT_ACCEPTED":
      return toolOk(exchanges, "complete_checkout") || Boolean(state.order) ? "PASS" : "FAIL";
    case "PAYMENT_RECONCILED":
      if (state.outcome_unknown) return "UNRESOLVED";
      if (["CAPTURED_RECONCILED", "FAILED_VERIFIED", "CANCELLED_VERIFIED"].includes(state.payment_status ?? "")) return "PASS";
      if (state.payment_status || state.order) return "FAIL";
      return "FAIL";
    case "ORDER_CONFIRMED":
      return state.order || state.merchant_order_id ? "PASS" : "FAIL";
    default:
      return "NOT_REACHED";
  }
}

export function evaluateStages(
  exchanges: ToolExchangeRecord[],
  state: PublicState,
  scenario?: ScenarioDefinition,
): RunStageResult[] {
  const out: RunStageResult[] = [];
  let blocked = false;
  for (const stage of PROOF_STAGES) {
    if (blocked && stage !== "OFFER_DECISION") {
      const na = stage === "OFFER_DECISION" && !offerInPlay(state, scenario);
      out.push({
        stage,
        result: na ? "NOT_APPLICABLE" : "NOT_REACHED",
        evidence_refs: [],
        detail: na ? "No Offer was in play" : "Prior stage did not pass",
      });
      continue;
    }
    const result = stageFromTools(stage, exchanges, state, scenario);
    const refs = exchanges.filter((e) => evidenceTool(stage).includes(e.tool_name)).map((e) => e.tool_exchange_id);
    out.push({
      stage,
      result,
      evidence_refs: refs,
      detail: result === "NOT_APPLICABLE" ? "No Offer was in play" : result,
    });
    if (result === "FAIL" || result === "UNRESOLVED") blocked = true;
  }
  return out;
}

function evidenceTool(stage: ProofStage): string[] {
  switch (stage) {
    case "DISCOVERY":
      return ["get_capabilities", "create_session", "set_intent"];
    case "CATALOG_RESOLUTION":
      return ["search_catalog", "get_product"];
    case "CART_VALID":
      return ["add_cart_item", "update_cart_item", "get_cart"];
    case "OFFER_DECISION":
      return ["accept_offer", "apply_offer"];
    case "QUOTE_HELD":
      return ["prepare_checkout"];
    case "CHECKOUT_ACCEPTED":
      return ["complete_checkout"];
    case "PAYMENT_RECONCILED":
    case "ORDER_CONFIRMED":
      return ["get_order", "complete_checkout"];
    default:
      return [];
  }
}

export function gradeRequirements(scenario: ScenarioDefinition | undefined, evidence: AssertionEvidence): RunRequirementGrade[] {
  const assertions = scenario?.required_terminal_assertions ?? [];
  return assertions.map((assertion, i) => {
    const keys = Object.keys(assertion);
    return {
      requirement_id: `req_${i}_${keys[0] ?? "assertion"}`,
      category: categoryFor(assertion),
      result: assertionHolds(assertion, evidence) ? "PASS" : "FAIL",
      assertion,
    };
  });
}

function categoryFor(assertion: Record<string, unknown>): RequirementCategory {
  if ("offer_status" in assertion) return "OFFER";
  if ("payment_status" in assertion) return "PAYMENT";
  if ("search_sku_prefix" in assertion) return "PRODUCT";
  if ("totals_total_minor" in assertion) return "CHECKOUT";
  if ("substitution_responded" in assertion) return "ORDER";
  if ("signer_rejected_overspend" in assertion) return "SAFETY";
  if ("path" in assertion && String(assertion.path).includes("location")) return "LOCATION";
  if ("path" in assertion && String(assertion.path).includes("budget")) return "BUDGET";
  return "CHECKOUT";
}

export function classifyFailures(
  stages: RunStageResult[],
  events: RunEventRecord[],
  state: PublicState,
): RunFailure[] {
  const failures: RunFailure[] = [];
  const hostReject = events.some((e) => e.kind === "SIGNER_REJECTED" || e.kind === "HOST_REJECTED");
  const infra = events.some((e) => e.kind === "RUN_FAILED" || e.kind === "TRANSPORT_TIMEOUT");
  for (const stage of stages) {
    if (stage.result !== "FAIL" && stage.result !== "UNRESOLVED") continue;
    let domain: FailureDomain = "ATLAS_MERCHANT_DOMAIN";
    let code = `STAGE_${stage.stage}_${stage.result}`;
    if (stage.result === "UNRESOLVED" || state.outcome_unknown) {
      domain = "EXTERNAL_PROVIDER_UNCERTAINTY";
      code = "OUTCOME_UNKNOWN";
    } else if (stage.stage === "PAYMENT_RECONCILED") {
      domain = "PAYMENT_RECONCILIATION";
    } else if (stage.stage === "CHECKOUT_ACCEPTED" && hostReject) {
      domain = "ATLASLAB_HOST_BOUNDARY";
      code = "HOST_REJECTED";
    } else if (infra) {
      domain = "INFRASTRUCTURE";
    } else if (["DISCOVERY", "CATALOG_RESOLUTION", "CART_VALID"].includes(stage.stage)) {
      domain = "BUYER_REASONING";
    }
    failures.push({
      failure_id: newPrefixedId("fail"),
      domain,
      code,
      stage: stage.stage,
      message: stage.detail,
    });
  }
  return failures;
}

export function commerceOutcome(stages: RunStageResult[], state: PublicState): RunProof["commerce_outcome"] {
  if (state.outcome_unknown) return "UNRESOLVED";
  const pay = stages.find((s) => s.stage === "PAYMENT_RECONCILED");
  const order = stages.find((s) => s.stage === "ORDER_CONFIRMED");
  if (pay?.result === "UNRESOLVED") return "UNRESOLVED";
  if (pay?.result === "PASS" && order?.result === "PASS" && state.payment_status === "CAPTURED_RECONCILED") return "SUCCEEDED";
  if (stages.some((s) => s.result === "FAIL")) return "FAILED";
  return "NOT_EVALUATED";
}

export function buildTrajectory(events: RunEventRecord[], extraSecrets: string[] = []): TrajectoryStep[] {
  const laneFor = (source: string): TrajectoryStep["lane"] => {
    if (source === "HOST_BOUNDARY") return "HOST";
    if (source === "ATLAS_RESPONSE") return "ATLAS";
    if (source === "ATLASLAB_EVALUATOR" || source === "ATLASLAB_ORCHESTRATOR") return "EVALUATOR";
    return "BUYER";
  };
  return events.map((e) => ({
    sequence: e.record_sequence,
    occurred_at: e.occurred_at,
    lane: laneFor(e.source),
    title: e.kind,
    detail: redactUnknown(e.payload, extraSecrets) as Record<string, unknown>,
  }));
}

export function paymentAssurance(state: PublicState): PaymentAssuranceProjection {
  if (state.outcome_unknown) {
    return {
      display_state: "UNRESOLVED",
      payment_status: state.payment_status ?? null,
      outcome_unknown: true,
      frozen: Boolean(state.effectful_payment_frozen),
      order_id: state.merchant_order_id ?? null,
      caveat: "OUTCOME_UNKNOWN is unresolved, not failed. Retry and fulfillment stay frozen.",
    };
  }
  if (state.payment_status === "CAPTURED_RECONCILED") {
    return {
      display_state: "VERIFIED",
      payment_status: state.payment_status,
      outcome_unknown: false,
      frozen: false,
      order_id: state.merchant_order_id ?? null,
      caveat: "Razorpay Test Mode — Simulated. Provider fetch is payment truth.",
    };
  }
  if (state.payment_status === "FAILED_VERIFIED" || state.payment_status === "CANCELLED_VERIFIED") {
    return {
      display_state: "FAILED",
      payment_status: state.payment_status,
      outcome_unknown: false,
      frozen: false,
      order_id: state.merchant_order_id ?? null,
      caveat: "Terminal verified payment failure. Razorpay Test Mode — Simulated.",
    };
  }
  if (!state.payment_status && !state.order) {
    return {
      display_state: "NOT_EVALUATED",
      payment_status: null,
      outcome_unknown: false,
      frozen: false,
      order_id: null,
      caveat: "Payment was not reached on this run.",
    };
  }
  return {
    display_state: "INSUFFICIENT_EVIDENCE",
    payment_status: state.payment_status ?? null,
    outcome_unknown: false,
    frozen: Boolean(state.effectful_payment_frozen),
    order_id: state.merchant_order_id ?? null,
    caveat: "Payment evidence is incomplete.",
  };
}

export function computeProof(opts: {
  run: RunRecord;
  state: PublicState;
  exchanges: ToolExchangeRecord[];
  events: RunEventRecord[];
  scenario?: ScenarioDefinition;
}): RunProof {
  if (opts.events.length === 0 && opts.exchanges.length === 0) {
    return {
      run_id: opts.run.run_id,
      stages: PROOF_STAGES.map((stage) => ({
        stage,
        result: "NOT_REACHED",
        evidence_refs: [],
        detail: "UNAVAILABLE_SOURCE_EVIDENCE",
      })),
      requirements: [],
      failures: [],
      commerce_outcome: "NOT_EVALUATED",
      source: "UNAVAILABLE_SOURCE_EVIDENCE",
    };
  }
  const stages = evaluateStages(opts.exchanges, opts.state, opts.scenario);
  const requirements = gradeRequirements(opts.scenario, {
    state: opts.state,
    exchanges: opts.exchanges,
    events: opts.events,
    consent: opts.scenario?.consent_policy,
  });
  const failures = classifyFailures(stages, opts.events, opts.state);
  return {
    run_id: opts.run.run_id,
    stages,
    requirements,
    failures,
    commerce_outcome: commerceOutcome(stages, opts.state),
    source: "COMPUTED",
  };
}

export async function persistProof(
  store: LabStore,
  run: RunRecord,
  state: PublicState,
  scenario: ScenarioDefinition | undefined,
  extraSecrets: string[] = [],
): Promise<RunProof> {
  const events = await store.listEvents(run.run_id);
  const exchanges = await store.listToolExchanges(run.run_id);
  const proof = computeProof({ run, state, exchanges, events, scenario });
  const traj = buildTrajectory(events, extraSecrets);
  const assurance = paymentAssurance(state);
  await store.putRunProof(run.run_id, proof, traj, assurance);
  return proof;
}

export async function getOrComputeProof(
  store: LabStore,
  run: RunRecord,
  scenario?: ScenarioDefinition,
  extraSecrets: string[] = [],
): Promise<{ proof: RunProof; trajectory: TrajectoryStep[]; assurance: PaymentAssuranceProjection }> {
  const stored = await store.getRunProof(run.run_id);
  if (stored) return stored;
  const events = await store.listEvents(run.run_id);
  const exchanges = await store.listToolExchanges(run.run_id);
  const proj = await store.latestProjection(run.run_id);
  const state = proj?.public_state ?? {};
  const proof = computeProof({ run, state, exchanges, events, scenario });
  const trajectory = buildTrajectory(events, extraSecrets);
  const assurance = paymentAssurance(state);
  if (proof.source === "COMPUTED") {
    await store.putRunProof(run.run_id, proof, trajectory, assurance);
  }
  return { proof, trajectory, assurance };
}

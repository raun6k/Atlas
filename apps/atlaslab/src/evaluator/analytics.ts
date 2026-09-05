import { utcNow } from "../ids.js";
import type { LabStore } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { PROOF_STAGES, type RunProof, type RunRecord } from "../types.js";
import { cannotEnterDenominator } from "./framework2.js";
import { extractRevenueMinor, getOrComputeProof } from "./proof.js";
import { COMMERCIAL_SCENARIO_ID } from "../model-eval/missions.js";
import { loadCommercialReport } from "../model-eval/suite.js";

export function envelope(requestId: string, data: unknown, extra?: { partial?: boolean; unavailable_sections?: Array<{ section: string; code: string; message: string }>; freshness?: string }) {
  const now = utcNow();
  return {
    request_id: requestId,
    generated_at: now,
    data_freshness_at: extra?.freshness ?? now,
    evaluator_set_version: "eval_v2_proof",
    projection_version: "proof_v1",
    partial: extra?.partial ?? false,
    unavailable_sections: extra?.unavailable_sections ?? [],
    data,
  };
}

export async function analyticsOverview(store: LabStore, orch: Orchestrator) {
  const runs = await store.listRuns();
  const eligible = runs.filter((r) => !cannotEnterDenominator(r));
  const proofs = await proofsFor(store, orch, eligible);
  const ladder = PROOF_STAGES.map((stage) => {
    const rows = proofs.map((p) => p.stages.find((s) => s.stage === stage)).filter(Boolean);
    const applicable = rows.filter((s) => s && s.result !== "NOT_APPLICABLE" && s.result !== "NOT_REACHED");
    const passed = applicable.filter((s) => s?.result === "PASS").length;
    return { stage, passed, eligible: applicable.length, unresolved: rows.filter((s) => s?.result === "UNRESOLVED").length };
  });
  const succeeded = proofs.filter((p) => p.commerce_outcome === "SUCCEEDED").length;
  return {
    claims: {
      sellability: { numerator: succeeded, denominator: eligible.length, cohort: "BENCHMARK_ELIGIBLE" },
    },
    ladder,
    blockers: topFailures(proofs),
    evidence_quality: {
      eligible_runs: eligible.length,
      excluded_runs: runs.length - eligible.length,
      unavailable_source_evidence: proofs.filter((p) => p.source === "UNAVAILABLE_SOURCE_EVIDENCE").length,
    },
    razorpay_test_mode: true,
  };
}

export async function analyticsSellability(store: LabStore, orch: Orchestrator) {
  const runs = await store.listRuns();
  const eligible = runs.filter((r) => !cannotEnterDenominator(r));
  const proofs = await proofsFor(store, orch, eligible);
  const stages = PROOF_STAGES.map((stage) => {
    const rows = proofs.map((p) => p.stages.find((s) => s.stage === stage));
    const counted = rows.filter((s) => s && s.result !== "NOT_APPLICABLE");
    const passed = counted.filter((s) => s?.result === "PASS").length;
    const excluded = rows.filter((s) => s?.result === "NOT_APPLICABLE").length;
    return { stage, passed, eligible: counted.length, exclusions: excluded };
  });
  return {
    stages,
    numerator: proofs.filter((p) => p.commerce_outcome === "SUCCEEDED").length,
    denominator: eligible.length,
    cohort: "BENCHMARK_ELIGIBLE",
    excluded_run_types: ["DETERMINISTIC_SCENARIO", "CUSTOM_MISSION"],
    excluded_suite_scenario_ids: ["suite_qm_v1", "suite_agent_compat_v1", "suite_commercial_uplift_v1"],
    live_product:
      "Agent Compatibility and Commercial Uplift suite POSTs are the live model eval product. Single-scenario BENCHMARK_MODEL sellability is exploratory.",
  };
}

export async function analyticsFailures(store: LabStore, orch: Orchestrator) {
  const runs = await store.listRuns();
  const proofs = await proofsFor(store, orch, runs);
  const byDomain: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const p of proofs) {
    for (const f of p.failures) {
      byDomain[f.domain] = (byDomain[f.domain] ?? 0) + 1;
      byStage[f.stage] = (byStage[f.stage] ?? 0) + 1;
      byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    }
  }
  return { by_domain: byDomain, by_stage: byStage, by_code: byCode };
}

export async function analyticsIssues(store: LabStore, orch: Orchestrator) {
  const runs = await store.listRuns();
  const proofs = await proofsFor(store, orch, runs);
  const items = proofs.flatMap((p) =>
    p.failures.map((f) => ({
      source: "ATLASLAB" as const,
      run_id: p.run_id,
      domain: f.domain,
      code: f.code,
      stage: f.stage,
      message: f.message,
    })),
  );
  return { items, source: "ATLASLAB" };
}

export async function analyticsMerchantOutcomes(store: LabStore, orch: Orchestrator) {
  const runs = await store.listRuns();
  const eligible = runs.filter((r) => !cannotEnterDenominator(r));
  const proofs = await proofsFor(store, orch, eligible);
  const latestCommercial = [...runs].reverse().find((run) => run.scenario_id === COMMERCIAL_SCENARIO_ID);
  const commercialReport = latestCommercial ? await loadCommercialReport(store, latestCommercial.run_id) : undefined;
  const pairs = commercialReport?.pairs ?? [];
  const stageMetric = (stage: (typeof PROOF_STAGES)[number], name: string) => {
    if (eligible.length === 0) {
      return { name, eligible: false, evidence_status: "MISSING" as const };
    }
    const rows = proofs.map((p) => p.stages.find((s) => s.stage === stage));
    const counted = rows.filter((s) => s && s.result !== "NOT_APPLICABLE" && s.result !== "NOT_REACHED");
    const passed = counted.filter((s) => s?.result === "PASS").length;
    return {
      name,
      eligible: true,
      evidence_status: "COUNTED" as const,
      numerator: passed,
      denominator: counted.length,
      value: passed,
    };
  };
  const revenues: number[] = [];
  for (const run of eligible) {
    const proj = await store.latestProjection(run.run_id);
    const minor = extractRevenueMinor(proj?.public_state);
    if (typeof minor === "number") revenues.push(minor);
  }
  return {
    cohort: "BENCHMARK_ELIGIBLE",
    excluded_runs: runs.length - eligible.length,
    metrics: [
      stageMetric("DISCOVERY", "ai_buyer_discovery_success"),
      stageMetric("CATALOG_RESOLUTION", "catalog_resolution_success"),
      stageMetric("CART_VALID", "cart_completion"),
      stageMetric("OFFER_DECISION", "offer_exposure"),
      stageMetric("QUOTE_HELD", "checkout_proposal_creation"),
      stageMetric("CHECKOUT_ACCEPTED", "payment_processing"),
      stageMetric("PAYMENT_RECONCILED", "payment_reconciliation"),
      stageMetric("ORDER_CONFIRMED", "confirmed_orders"),
      revenues.length
        ? { name: "captured_revenue", eligible: true, evidence_status: "COUNTED", value: revenues.reduce((a, b) => a + b, 0) }
        : { name: "captured_revenue", eligible: false, evidence_status: "MISSING" },
      { name: "unresolved_money", eligible: true, evidence_status: "COUNTED", value: proofs.filter((p) => p.commerce_outcome === "UNRESOLVED").length },
      pairs.length
        ? {
            name: "control_treatment_task_success",
            eligible: true,
            evidence_status: "COUNTED",
            numerator: pairs.filter((p) => p.included_in_rpas && p.delta_rpas_minor != null).length,
            denominator: pairs.filter((p) => p.included_in_rpas).length,
          }
        : { name: "control_treatment_task_success", eligible: false, evidence_status: "EXCLUDED" },
      pairs.some((p) => p.delta_rpas_minor != null)
        ? { name: "strategy_level_order_delta", eligible: true, evidence_status: "COUNTED", value: pairs.filter((p) => p.delta_rpas_minor != null).length }
        : { name: "strategy_level_order_delta", eligible: false, evidence_status: "MISSING" },
    ],
    caveat: "Missing evidence is omitted, never coerced to zero. Test Mode does not support a live-commerce revenue claim.",
  };
}

export async function analyticsExperiments(store: LabStore) {
  const legacyPairs = await store.listPairs();
  const runs = await store.listRuns();
  const latest = [...runs].reverse().find((run) => run.scenario_id === COMMERCIAL_SCENARIO_ID);
  const report = latest ? await loadCommercialReport(store, latest.run_id) : undefined;
  return {
    source: report ? "COMMERCIAL_UPLIFT" : "NONE",
    report_id: latest && report ? `uplift_${latest.run_id}` : null,
    run_id: latest?.run_id ?? null,
    model_id: report?.model_id ?? null,
    fixture_digest: report?.fixture_digest ?? null,
    portfolio: report?.portfolio ?? null,
    proof: report?.proof ?? null,
    pairs: report?.pairs ?? [],
    legacy_pairs: legacyPairs.map((pair) => ({
      pair_id: pair.pair_id,
      eligible: pair.eligible,
      exclusion_reason: pair.exclusion_reason,
      first_arm: pair.first_arm,
      deltas: pair.deltas,
      guardrails: pair.guardrails,
      missing_revenue: pair.deltas == null && pair.exclusion_reason === "MISSING_REVENUE",
    })),
    caveat: report?.caveat ?? "No commercial report exists. Test Mode does not support a real-world causal uplift claim.",
  };
}

async function proofsFor(store: LabStore, orch: Orchestrator, runs: RunRecord[]): Promise<RunProof[]> {
  const out: RunProof[] = [];
  for (const run of runs) {
    const scn = orch.scenarios.find((s) => s.scenario_id === run.scenario_id);
    const got = await getOrComputeProof(store, run, scn, orch.extraSecrets());
    out.push(got.proof);
  }
  return out;
}

function topFailures(proofs: RunProof[]) {
  const counts = new Map<string, number>();
  for (const p of proofs) {
    for (const f of p.failures) {
      const key = `${f.stage}:${f.code}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => ({ key, count }));
}

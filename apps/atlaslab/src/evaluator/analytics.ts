import { utcNow } from "../ids.js";
import type { LabStore } from "../db/store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { PROOF_STAGES, type RunProof, type RunRecord } from "../types.js";
import { cannotEnterDenominator } from "./framework2.js";
import { getOrComputeProof } from "./proof.js";

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

export async function analyticsExperiments(store: LabStore) {
  const pairs = await store.listPairs();
  return {
    pairs: pairs.map((pair) => ({
      pair_id: pair.pair_id,
      eligible: pair.eligible,
      exclusion_reason: pair.exclusion_reason,
      first_arm: pair.first_arm,
      deltas: pair.deltas,
      guardrails: pair.guardrails,
      missing_revenue: pair.deltas == null && pair.exclusion_reason === "MISSING_REVENUE",
    })),
    caveat: "This controlled Test Mode evaluation does not support a real-world causal uplift claim.",
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

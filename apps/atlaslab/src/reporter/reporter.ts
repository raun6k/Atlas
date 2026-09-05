import { wrapArtifact } from "./provenance.js";
import { newPrefixedId, sha256Hex } from "../ids.js";
import type { LabStore } from "../db/store.js";
import { cannotEnterDenominator } from "../evaluator/framework2.js";
import type { ArtifactRecord, PairResultRecord, RunRecord } from "../types.js";

export async function buildReport(
  store: LabStore,
  opts: { kind: "sellability" | "incrementality" | "contract"; runs: RunRecord[]; pair?: PairResultRecord },
): Promise<ArtifactRecord[]> {
  const eligible = opts.runs.filter((r) => !cannotEnterDenominator(r));
  if (opts.kind !== "contract") {
    const excluded = opts.runs.filter(cannotEnterDenominator).map((r) => ({
      id: r.run_id,
      run_id: r.run_id,
      run_type: r.run_type,
      evidence_eligibility: r.evidence_eligibility,
      reason: "deterministic and custom runs cannot enter benchmark denominators",
    }));
    const inner = {
      kind: opts.kind,
      razorpay_test_mode: true,
      evidence_label:
        opts.kind === "incrementality"
          ? "Legacy pair-first incrementality. Live product is POST /lab/v1/commercial-uplift-eval (RPAS including zeros)."
          : "Legacy Agent Sellability over leftover BENCHMARK_MODEL runs. Live product is POST /lab/v1/agent-compatibility-eval.",
      forbidden_claim: "real-world causal uplift",
      history_source: "synthetic_fixture",
      numerator: eligible.filter((r) => r.state === "COMPLETED").length,
      denominator: eligible.length,
      eligible_pairs: opts.pair?.eligible ? 1 : 0,
      excluded_pairs: opts.pair && !opts.pair.eligible ? [{ reason: opts.pair.exclusion_reason }] : excluded,
      excluded,
      pair: opts.pair ?? null,
      live_product: "Commercial Uplift suite (RPAS including zeros) replaces first-pair incrementality as the live product.",
    };
    const wrapped = wrapArtifact(inner, {
      evaluator_version: "eval_v2_proof",
      fixture_snapshot_id: opts.runs[0]?.fixture_snapshot_id ?? null,
      fixture_digest: opts.runs[0]?.fixture_digest ?? null,
      model_id: opts.runs[0]?.requested_model_id ?? null,
      returned_model_id: opts.runs[0]?.returned_model_id ?? null,
      run_ids: opts.runs.map((r) => r.run_id),
      exclusions: excluded.map((e) => ({ id: e.run_id, reason: e.reason })),
      evidence_quality: eligible.length === 0 ? "unavailable" : "measured",
      evidence_level: "controlled_test_mode",
    });
    return save(store, { ...inner, provenance: wrapped.provenance }, opts.kind, incrementalityCsv(opts.pair));
  }
  const inner = {
    kind: "contract",
    razorpay_test_mode: true,
    note: "Framework 0 proves programmed public-interface behavior, not Agent Sellability.",
    history_source: "synthetic_fixture",
    runs: opts.runs.map((r) => ({ run_id: r.run_id, run_type: r.run_type, state: r.state })),
  };
  const wrapped = wrapArtifact(inner, {
    evaluator_version: "eval_v2_deterministic_suite",
    fixture_snapshot_id: opts.runs[0]?.fixture_snapshot_id ?? null,
    fixture_digest: opts.runs[0]?.fixture_digest ?? null,
    run_ids: opts.runs.map((r) => r.run_id),
    evidence_quality: "confirmed",
    evidence_level: "contract",
  });
  return save(store, { ...inner, provenance: wrapped.provenance }, "contract");
}

function incrementalityCsv(pair?: PairResultRecord): string {
  const deltas = pair?.deltas as
    | { control_revenue_minor?: number; treatment_revenue_minor?: number; absolute_revenue_delta_minor?: number }
    | null
    | undefined;
  if (!deltas) return "metric,value\nrazorpay_test_mode,true\n";
  return [
    "metric,value",
    "razorpay_test_mode,true",
    `control_revenue_minor,${deltas.control_revenue_minor ?? ""}`,
    `treatment_revenue_minor,${deltas.treatment_revenue_minor ?? ""}`,
    `absolute_revenue_delta_minor,${deltas.absolute_revenue_delta_minor ?? ""}`,
  ].join("\n") + "\n";
}

async function save(store: LabStore, body: unknown, kind: string, csvBody = "metric,value\nrazorpay_test_mode,true\n"): Promise<ArtifactRecord[]> {
  const json = JSON.stringify(body, null, 2);
  const reportId = newPrefixedId("rpt");
  const jsonArt: ArtifactRecord = {
    artifact_id: newPrefixedId("art"),
    report_id: reportId,
    kind: `${kind}.json`,
    content_digest: sha256Hex(json),
    local_path: null,
    body: json,
  };
  const csvArt: ArtifactRecord = {
    artifact_id: newPrefixedId("art"),
    report_id: reportId,
    kind: `${kind}.csv`,
    content_digest: sha256Hex(csvBody),
    local_path: null,
    body: csvBody,
  };
  await store.putArtifact(jsonArt);
  await store.putArtifact(csvArt);
  return [jsonArt, csvArt];
}

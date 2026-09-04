import { canonicalize } from "../canonical.js";
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
      run_id: r.run_id,
      run_type: r.run_type,
      evidence_eligibility: r.evidence_eligibility,
      reason: "deterministic and custom runs cannot enter benchmark denominators",
    }));
    const body = {
      kind: opts.kind,
      razorpay_test_mode: true,
      evidence_label:
        opts.kind === "incrementality"
          ? "The treatment improved the named metric in this controlled Test Mode evaluation."
          : "Agent Sellability over eligible BENCHMARK_MODEL runs only.",
      forbidden_claim: "real-world causal uplift",
      numerator: eligible.filter((r) => r.state === "COMPLETED").length,
      denominator: eligible.length,
      excluded,
      pair: opts.pair ?? null,
    };
    return save(store, body, opts.kind);
  }
  const body = {
    kind: "contract",
    razorpay_test_mode: true,
    note: "Framework 0 proves programmed public-interface behavior, not Agent Sellability.",
    runs: opts.runs.map((r) => ({ run_id: r.run_id, run_type: r.run_type, state: r.state })),
  };
  return save(store, body, "contract");
}

async function save(store: LabStore, body: unknown, kind: string): Promise<ArtifactRecord[]> {
  const json = JSON.stringify(body, null, 2);
  const reportId = newPrefixedId("rpt");
  const jsonArt: ArtifactRecord = {
    artifact_id: newPrefixedId("art"),
    report_id: reportId,
    kind: `${kind}.json`,
    content_digest: sha256Hex(canonicalize(body)),
    local_path: null,
    body: json,
  };
  const csvArt: ArtifactRecord = {
    artifact_id: newPrefixedId("art"),
    report_id: reportId,
    kind: `${kind}.csv`,
    content_digest: sha256Hex(json),
    local_path: null,
    body: "metric,value\nrazorpay_test_mode,true\n",
  };
  await store.putArtifact(jsonArt);
  await store.putArtifact(csvArt);
  return [jsonArt, csvArt];
}

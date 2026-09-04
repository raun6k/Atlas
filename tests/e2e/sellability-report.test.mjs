#!/usr/bin/env node
/**
 * Paired sellability / incrementality proof report with Test Mode caveats.
 * Deterministic and custom Lab runs must not enter Agent Sellability or causal-uplift denominators.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lab = process.env.ATLASLAB_API_URL || "http://127.0.0.1:8090";
const token = process.env.ATLASLAB_API_TOKEN || process.env.ATLASLAB_SERVICE_TOKEN || "";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../artifacts");
mkdirSync(outDir, { recursive: true });

let reports = [];
let pairs = [];
let live = false;
try {
  const res = await fetch(`${lab}/health/live`);
  live = res.ok;
} catch {
  live = false;
}

if (live) {
  const headers = { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  try {
    reports = (await (await fetch(`${lab}/lab/v1/reports`, { headers })).json()).items ?? [];
    pairs = (await (await fetch(`${lab}/lab/v1/pairs`, { headers })).json()).items ?? [];
  } catch {
    reports = [];
    pairs = [];
  }
}

const eligibleReports = reports.filter((r) => r.evidence_eligibility === "BENCHMARK_ELIGIBLE");
const ineligible = reports.filter((r) =>
  ["CONTRACT_EVIDENCE_ONLY", "BENCHMARK_INELIGIBLE", "EXPLORATORY"].includes(r.evidence_eligibility) ||
  r.run_type === "DETERMINISTIC_SCENARIO" ||
  r.run_type === "CUSTOM_MISSION",
);

const doc = {
  generated_at: new Date().toISOString(),
  simulated_money: true,
  live_mode: false,
  caveat:
    "Razorpay Test Mode pairs do not establish real-world causal uplift. Deterministic and custom AtlasLab runs are excluded from Agent Sellability and incrementality denominators.",
  lab_reachable: live,
  reports_total: reports.length,
  sellability_denominator: eligibleReports.length,
  excluded_deterministic_or_custom: ineligible.length,
  pairs_total: pairs.length,
};

writeFileSync(join(outDir, "sellability-incrementality-report.json"), JSON.stringify(doc, null, 2));
console.log("wrote artifacts/sellability-incrementality-report.json");
console.log(doc.caveat);
if (!live) {
  console.log("Lab HTTP not reachable; report records empty denominators without claiming uplift.");
}

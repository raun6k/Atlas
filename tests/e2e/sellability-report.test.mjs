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
let sellability = {};
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
    const analytics = await (await fetch(`${lab}/lab/v1/analytics/sellability`, { headers })).json();
    sellability = analytics.data ?? {};
  } catch {
    reports = [];
    pairs = [];
    sellability = {};
  }
}

const contractReports = reports.filter((r) => r.kind === "CONTRACT");
const compatibilityReports = reports.filter((r) => r.kind === "AGENT_COMPATIBILITY");
const commercialReports = reports.filter((r) => r.kind === "COMMERCIAL_UPLIFT");
const commercial = commercialReports.at(-1) ?? null;
const proof = commercial?.report?.proof ?? null;

const doc = {
  generated_at: new Date().toISOString(),
  simulated_money: true,
  live_mode: false,
  caveat:
    "Razorpay Test Mode pairs do not establish real-world causal uplift. Deterministic and custom AtlasLab runs are excluded from Agent Sellability and incrementality denominators.",
  lab_reachable: live,
  reports_total: reports.length,
  sellability_denominator: Number(sellability.denominator ?? 0),
  sellability_numerator: Number(sellability.numerator ?? 0),
  excluded_deterministic_or_custom: Number(sellability.excluded_deterministic_or_custom ?? 0),
  pairs_total: pairs.length,
  report_kinds: {
    contract: contractReports.length,
    agent_compatibility: compatibilityReports.length,
    commercial_uplift: commercialReports.length,
  },
  commercial: commercial
    ? {
        report_id: commercial.report_id,
        run_id: commercial.run_id,
        model_id: commercial.report?.model_id ?? null,
        fixture_digest: commercial.report?.fixture_digest ?? null,
        proof,
        portfolio: commercial.report?.portfolio ?? null,
      }
    : null,
};

writeFileSync(join(outDir, "sellability-incrementality-report.json"), JSON.stringify(doc, null, 2));
console.log("wrote artifacts/sellability-incrementality-report.json");
console.log(doc.caveat);
if (!live) {
  console.error("Lab HTTP not reachable; refusing empty sellability report");
  process.exit(1);
}

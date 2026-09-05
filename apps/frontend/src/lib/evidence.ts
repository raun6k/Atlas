export const EVIDENCE_STATES = [
  "confirmed",
  "measured",
  "partial",
  "unavailable",
  "ineligible",
  "unresolved",
  "simulated",
  "test_mode_only",
] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export interface EvidenceMetric {
  name: string;
  label: string;
  state: EvidenceState;
  value?: string | number | null;
  present: boolean;
  message: string;
}

export function normalizeEvidence(raw: string | undefined | null): EvidenceState {
  const s = (raw ?? "").toLowerCase().replace(/-/g, "_");
  if (s === "test_mode_only" || s === "test mode only") return "test_mode_only";
  if ((EVIDENCE_STATES as readonly string[]).includes(s)) return s as EvidenceState;
  if (s === "verified" || s === "ready" || s === "complete" || s === "counted") return "measured";
  if (s === "unknown" || s === "not_ready") return "unavailable";
  if (s === "degraded") return "partial";
  return "unavailable";
}

export function metricFromOutcome(row: {
  name?: string;
  evidence?: string;
  evidence_status?: string;
  value?: number;
  value_present?: boolean;
  eligible?: boolean;
  message?: string;
}): EvidenceMetric {
  const state = row.eligible === false ? "ineligible" : normalizeEvidence(row.evidence_status ?? row.evidence);
  const present = Boolean(row.value_present) && state !== "unavailable" && state !== "ineligible";
  return {
    name: row.name ?? "metric",
    label: (row.name ?? "metric").replace(/_/g, " "),
    state,
    value: present ? row.value ?? null : null,
    present,
    message:
      row.message ||
      (state === "unavailable"
        ? "Value is unavailable — it is not zero."
        : state === "ineligible"
          ? "This metric is ineligible for the current claim level."
          : ""),
  };
}

export function neverZeroMissing(metric: EvidenceMetric): string {
  if (!metric.present) {
    if (metric.state === "unavailable") return `${metric.label} unavailable — missing evidence is not shown as 0.`;
    if (metric.state === "ineligible") return `${metric.label} ineligible.`;
    if (metric.state === "unresolved") return `${metric.label} unresolved.`;
  }
  return metric.message;
}

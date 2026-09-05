import type { EvidenceMetric } from "@/lib/evidence";
import { neverZeroMissing } from "@/lib/evidence";

export function EvidenceMetricCard({ metric }: { metric: EvidenceMetric }) {
  return (
    <article className="card" data-testid={`metric-${metric.name}`} data-evidence-state={metric.state}>
      <p className="kicker">{metric.state.replace(/_/g, " ")}</p>
      <h3>{metric.label}</h3>
      <p className="value">{metric.present ? String(metric.value) : "—"}</p>
      <p className="muted">{neverZeroMissing(metric) || metric.message}</p>
    </article>
  );
}

export function StateChip({ state, children }: { state: string; children: React.ReactNode }) {
  return (
    <span className="chip" data-evidence-state={state.toLowerCase()}>
      {children}
    </span>
  );
}

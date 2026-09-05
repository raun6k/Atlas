import { EvidenceMetricCard } from "./EvidenceMetric";
import { PaymentAssuranceCard, type AssuranceView } from "./PaymentAssurance";
import { DEFENSIBLE_CLAIMS, EVIDENCE_LEVELS, NOT_CLAIMED } from "@/lib/claims";
import type { EvidenceMetric } from "@/lib/evidence";
import { metricFromOutcome } from "@/lib/evidence";
import type { AuditProvenance, AuditState, AuditView } from "@/lib/audit-view";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function list(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>> : [];
}

function audit(data: Record<string, unknown>): AuditView | null {
  return data.audit_view && typeof data.audit_view === "object" ? (data.audit_view as AuditView) : null;
}

function provenanceLabel(value: AuditProvenance): string {
  return [
    value.source,
    value.report_id && `report ${value.report_id}`,
    value.run_id && `run ${value.run_id}`,
    value.content_digest && `digest ${value.content_digest.slice(0, 12)}`,
  ].filter(Boolean).join(" · ");
}

function evidenceLabel(state: AuditState): string {
  return state === "available" ? "measured" : state;
}

export function ScreenView({ screen, data }: { screen: string; data: Record<string, unknown> }) {
  if (screen === "home") return <Home data={data} />;
  if (screen === "sellability") return <Sellability data={data} />;
  if (screen === "growth") return <Growth data={data} />;
  if (screen === "commerce") return <Commerce data={data} />;
  if (screen === "merchant") return <Merchant data={data} />;
  if (screen === "trust") return <Trust data={data} />;
  if (screen === "system") return <System data={data} />;
  return <Demo data={data} />;
}

function Home({ data }: { data: Record<string, unknown> }) {
  const att = rec(data.attention);
  const items = list(att.items);
  const summary = rec(att.summary);
  const latest = rec(data.latest_order);
  const outcomes = (Array.isArray(data.outcomes) ? data.outcomes : []) as EvidenceMetric[];
  return (
    <>
      <section className="cards" data-testid="attention-state">
        <article className="card">
          <p className="kicker">attention</p>
          <h3>{String(summary.headline || att.headline || "Attention")}</h3>
          <p className="muted">{items.length ? String(items[0]?.explanation ?? "") : "No unresolved merchant attention."}</p>
        </article>
        <article className="card" data-testid="readiness">
          <p className="kicker">readiness</p>
          <h3>Current readiness</h3>
          <p>{String(rec(data.health).status || rec(rec(data.home).readiness).message || rec(data.system).status || "partial")}</p>
        </article>
        <article className="card" data-testid="latest-order">
          <p className="kicker">confirmed order</p>
          <h3>{String(latest.merchant_order_id || "unavailable")}</h3>
          <p className="muted">Status {String(latest.status || latest.payment_public_status || "unavailable")} — not inferred from a browser success screen.</p>
        </article>
      </section>
      <h2>Latest evidence</h2>
      <div className="cards">
        {outcomes.length
          ? outcomes.map((m) => <EvidenceMetricCard key={m.name} metric={m} />)
          : list(rec(data).metrics).map((row, i) => <EvidenceMetricCard key={i} metric={metricFromOutcome(row)} />)}
      </div>
      <PaymentAssuranceCard card={(data.payment_assurance as AssuranceView) || null} />
    </>
  );
}

function Sellability({ data }: { data: Record<string, unknown> }) {
  const view = audit(data)?.sellability;
  const caps = view?.capabilities.value;
  const tools = Array.isArray(caps?.tools) ? caps.tools.map(String) : [];
  const stages = view?.stages.value;
  return (
    <section data-testid="sellability-evidence">
      <article className="card" data-evidence-state={view?.capabilities.state ?? "unavailable"}>
        <p className="kicker">{evidenceLabel(view?.capabilities.state ?? "unavailable")}</p>
        <h3>Public MCP capability</h3>
        <p>{tools.length ? tools.join(", ") : "Unavailable — no capability payload."}</p>
      </article>
      <article className="card" data-evidence-state={view?.contract_report.state ?? "unavailable"}>
        <p className="kicker">{evidenceLabel(view?.contract_report.state ?? "unavailable")}</p>
        <h3>Schema readiness</h3>
        <p>{caps ? String(caps.contract_version ?? caps.contract_family ?? "Contract version missing") : "Unavailable"}</p>
        {view?.contract_report && <p className="muted">{provenanceLabel(view.contract_report.provenance)}</p>}
      </article>
      <article className="card" data-testid="buyer-journey" data-evidence-state={view?.compatibility_report.state ?? "unavailable"}>
        <p className="kicker">{evidenceLabel(view?.compatibility_report.state ?? "unavailable")}</p>
        <h3>Agent compatibility report</h3>
        <p>{view?.compatibility_report.value ? "Agent compatibility report exists." : "No Agent Compatibility report is available."}</p>
        {view?.compatibility_report && <p className="muted">{provenanceLabel(view.compatibility_report.provenance)}</p>}
      </article>
      <h2>Live sellability stages</h2>
      <p data-testid="sellability-cohort">
        Cohort {view?.cohort ?? "unavailable"} · {view?.numerator ?? "—"} / {view?.denominator ?? "—"} successful
      </p>
      {stages ? (
        <Table rows={stages.map((stage) => ({ ...stage } as Record<string, unknown>))} cols={["stage", "passed", "eligible", "exclusions"]} />
      ) : (
        <p className="muted" data-evidence-state={view?.stages.state ?? "unavailable"}>
          Sellability analytics {view?.stages.state ?? "unavailable"}.
        </p>
      )}
      {view?.stages && <p className="muted">Analytics provenance: {provenanceLabel(view.stages.provenance)}</p>}
    </section>
  );
}

function Growth({ data }: { data: Record<string, unknown> }) {
  const growth = audit(data)?.growth;
  const proof = growth?.proof.value;
  const portfolio = growth?.portfolio.value;
  const reportExists = growth?.report.state === "available";
  const eligible = proof?.eligible_pairs ?? null;
  const upliftEstablished = growth?.uplift_state === "available";
  const delta = portfolio?.delta_rpas_minor;
  return (
    <section data-testid="growth-report">
      <article className="card" data-testid="revenue-uplift" data-evidence-state={upliftEstablished ? "measured" : growth?.uplift_state ?? "unavailable"}>
        <p className="kicker">{upliftEstablished ? "measured" : growth?.uplift_state ?? "unavailable"}</p>
        <h3>Revenue uplift</h3>
        <p className="value">{upliftEstablished && typeof delta === "number" ? `${delta} minor units` : "—"}</p>
        <p className="muted">
          {upliftEstablished
            ? "Controlled Test Mode RPAS only."
            : reportExists && eligible === 0
              ? "Commercial report exists, but uplift is not established — 0 eligible confirmed-order pairs."
              : reportExists
                ? "Commercial report exists, but its eligible-pair proof is missing."
                : "Commercial report unavailable — uplift is not reported as zero."}
        </p>
        {growth?.report && <p className="muted">{provenanceLabel(growth.report.provenance)}</p>}
      </article>
      <div className="cards" data-testid="control-treatment">
        <article className="card" data-evidence-state={proof ? "measured" : "unavailable"}>
          <h3>Eligible pairs</h3>
          <p className="value">{proof ? String(eligible) : "—"}</p>
        </article>
        <article className="card" data-evidence-state={proof ? "measured" : "unavailable"}>
          <h3>Excluded pairs</h3>
          <p className="value">{proof ? String(proof.excluded_pairs.length) : "—"}</p>
        </article>
        <article className="card" data-testid="orders-by-arm">
          <h3>Confirmed orders (control / treatment)</h3>
          <p>{proof ? JSON.stringify(proof.confirmed_orders_by_arm) : "unavailable — no commercial proof"}</p>
        </article>
        <article className="card">
          <h3>Captured revenue by arm</h3>
          <p className="muted">Test Mode only. {proof ? JSON.stringify(proof.captured_revenue_by_arm) : "unavailable"}</p>
        </article>
        <article className="card">
          <h3>Task success</h3>
          <p>{proof ? JSON.stringify(proof.task_success_by_arm) : "unavailable"}</p>
        </article>
        <article className="card" data-evidence-state={proof ? "measured" : "unavailable"}>
          <h3>Safety failures</h3>
          <p>{proof ? String(proof.safety_failures) : "—"}</p>
        </article>
        <article className="card" data-evidence-state={proof ? (proof.unresolved_payment_count > 0 ? "unresolved" : "measured") : "unavailable"}>
          <h3>Unresolved payments</h3>
          <p>{proof ? String(proof.unresolved_payment_count) : "—"}</p>
        </article>
        <article className="card">
          <h3>Confidence intervals</h3>
          <p className="muted">{proof ? String(proof.confidence_intervals.reason ?? "unavailable") : "unavailable"}</p>
        </article>
        <article className="card" data-evidence-state={growth?.portfolio.state ?? "unavailable"}>
          <h3>Portfolio RPAS</h3>
          <p>{portfolio ? JSON.stringify(portfolio) : "unavailable — portfolio missing from commercial.report"}</p>
        </article>
      </div>
      <p data-testid="growth-caveat">{growth?.caveat ?? "Commercial evidence caveat unavailable."}</p>
      {EVIDENCE_LEVELS.map((lvl) => (
        <article className="card" key={lvl.id}>
          <p className="kicker">{lvl.id === "real" ? "unavailable" : "test_mode_only"}</p>
          <h3>{lvl.title}</h3>
          <p className="muted">{lvl.detail}</p>
        </article>
      ))}
    </section>
  );
}

function Commerce({ data }: { data: Record<string, unknown> }) {
  const mock = rec(data.commerce);
  const sessions = list(data.sessions).length ? list(data.sessions) : list(mock.sessions);
  const offers = list(data.offers).length ? list(data.offers) : list(mock.offers);
  const orders = list(data.orders).length ? list(data.orders) : list(mock.orders);
  return (
    <section data-testid="commerce-tables">
      <h2>Sessions</h2>
      <Table rows={sessions} cols={["session_id", "status", "mission"]} />
      <h2>Offers</h2>
      <div data-testid="offer-explanation">
        {offers.slice(0, 5).map((o) => (
          <article className="card" key={String(o.offer_id)}>
            <h3>{String(o.offer_id)}</h3>
            <p>{String(o.grounded_reason || o.terms || "No grounded explanation on this offer.")}</p>
          </article>
        ))}
      </div>
      <h2>Orders</h2>
      <Table rows={orders} cols={["merchant_order_id", "status", "payment_public_status"]} />
      <p className="muted" data-testid="future-substitutions">Future: substitution is not a public MCP tool.</p>
    </section>
  );
}

function Merchant({ data }: { data: Record<string, unknown> }) {
  const merchant = audit(data)?.merchant;
  const profile = merchant?.profile.value;
  const products = merchant?.products.value;
  const inventory = merchant?.inventory.value;
  return (
    <section data-testid="merchant-data">
      <article className="card" data-evidence-state={merchant?.profile.state ?? "unavailable"}>
        <p className="kicker">{evidenceLabel(merchant?.profile.state ?? "unavailable")}</p>
        <h3>{profile ? String(profile.display_name ?? "Display name missing") : "Merchant profile unavailable"}</h3>
        <p>{profile ? String(profile.currency ?? "Currency missing") : "No live profile payload."}</p>
      </article>
      <p data-testid="missing-catalog">
        {products ? `${products.length} live products loaded.` : `Catalog ${merchant?.products.state ?? "unavailable"} — not replaced with fixtures.`}
      </p>
      <h2>Products</h2>
      <Table rows={products ?? []} cols={["product_id", "name", "brand", "lifecycle"]} />
      <h2>Inventory</h2>
      <Table rows={inventory ?? []} cols={["location_id", "sku_id", "sellable_quantity", "stock_status"]} />
      <h2>Locations</h2>
      <Table rows={merchant?.locations.value ?? []} cols={["location_id", "name"]} />
      <p className="muted">Research: campaigns beyond fixture promotions are not claimed as a growth product.</p>
    </section>
  );
}

function Trust({ data }: { data: Record<string, unknown> }) {
  const trust = audit(data)?.trust;
  const payments = trust?.payments.value;
  const items = list(trust?.attention.value?.items);
  const paymentBlockCategories = new Set([
    "CAPTURED_UNBOUND",
    "EVIDENCE_REJECTED",
    "AUTHORIZATION_SECURITY",
    "MISSING_EVALUATION_EVIDENCE",
  ]);
  const blocked = items.find((item) =>
    item.retry_allowed === false &&
    (!item.category || paymentBlockCategories.has(String(item.category))))
    ?? payments?.find((payment) => String(payment.assurance.retry_allowed) === "false");
  return (
    <section>
      <h2>Unresolved money</h2>
      <div data-testid="unresolved-payment" data-evidence-state={trust?.payments.state ?? "unavailable"}>
        {payments?.length
          ? payments.map((payment, i) => <PaymentAssuranceCard key={i} card={payment.assurance as AssuranceView} />)
          : <PaymentAssuranceCard card={null} />}
      </div>
      <h2>Audit timeline</h2>
      <ul data-testid="audit-timeline">
        {trust?.audit.value?.map((event) => (
          <li key={String(event.audit_event_id)}>{String(event.event_kind)} — {String(event.summary_sentence)}</li>
        ))}
      </ul>
      <button type="button" disabled data-testid="retry-disabled">
        {blocked ? "Retry disabled — inspect provider evidence" : "No unsafe retry"}
      </button>
    </section>
  );
}

function System({ data }: { data: Record<string, unknown> }) {
  const health = rec(data.health);
  const comps = list(health.components).length ? list(health.components) : list(rec(data.system).components);
  return (
    <section data-testid="system-health">
      <p>Status {String(health.status || rec(data.system).status)}</p>
      <div className="cards">
        {comps.map((c) => (
          <article className="card" key={String(c.name)} data-evidence-state={String(c.evidence_status || "unavailable").toLowerCase()}>
            <p className="kicker">{String(c.evidence_status || c.status)}</p>
            <h3>{String(c.name)}</h3>
            <p className="muted">{String(c.detail)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Demo({ data }: { data: Record<string, unknown> }) {
  return (
    <section data-testid="demo-script">
      <ol className="demo">
        <li>Open merchant dashboard (this console).</li>
        <li>Show merchant readiness and public MCP schema (Sellability).</li>
        <li>Run one AI buyer journey via AtlasLab custom or compatibility eval.</li>
        <li>Show a deterministic offer decision on Commerce.</li>
        <li>Complete Razorpay Test Mode payment with the private runner.</li>
        <li>Show authenticated provider evidence on Trust.</li>
        <li>Show confirmed order on Home.</li>
        <li>Open the audit/payment timeline.</li>
        <li>Load paired control/treatment results on Growth.</li>
        <li>Show exactly what is proven and what is not claimed below.</li>
      </ol>
      <h2>Proven</h2>
      <ul>{DEFENSIBLE_CLAIMS.map((c) => <li key={c}>{c}</li>)}</ul>
      <h2>Not claimed</h2>
      <ul data-testid="not-claimed">{NOT_CLAIMED.map((c) => <li key={c}>{c}</li>)}</ul>
      <Home data={data} />
    </section>
  );
}

function Table({ rows, cols }: { rows: Array<Record<string, unknown>>; cols: string[] }) {
  if (!rows.length) return <p className="muted">No rows — unavailable, not zero.</p>;
  return (
    <table>
      <thead>
        <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map((r, i) => (
          <tr key={i}>
            {cols.map((c) => <td key={c}>{String(r[c] ?? "")}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

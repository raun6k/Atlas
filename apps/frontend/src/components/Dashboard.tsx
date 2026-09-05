import type { AuditView } from "@/lib/audit-view";
import type { LabExampleSuite } from "@/lib/lab-examples";
import { DEMO_CONFIRMED_ORDERS } from "@/lib/demo-orders";
import { FIXTURE_EVAL_NUMBERS } from "@/lib/eval-run";
import { strategyBlurb } from "@/lib/strategy-copy";
import { formatInrMinor, formatWhen, humanize } from "@/lib/format";
import { EvalRunButton } from "./EvalRunButton";
import {
  CodeChip,
  DataTable,
  EmptyState,
  Section,
  StatusMark,
  ToggleSection,
  UpstreamNotice,
  evidenceLabel,
  rec,
} from "./ui";

const LAB_EVALS = [
  {
    id: "deterministic" as const,
    title: "Deterministic eval",
    path: "POST /lab/v1/deterministic-eval",
    detail: "Contract evidence only. Public MCP tools and schemas against live Core.",
  },
  {
    id: "compatibility" as const,
    title: "Agent compatibility",
    path: "POST /lab/v1/agent-compatibility-eval",
    detail: "Controlled agent shopping through the QuickMart MCP contract. Not revenue.",
  },
  {
    id: "commercial" as const,
    title: "Commercial uplift",
    path: "POST /lab/v1/commercial-uplift-eval",
    detail: "Paired control versus treatment in Razorpay Test Mode. Not real-world causal uplift.",
  },
];

function audit(data: Record<string, unknown>): AuditView | null {
  return data.audit_view && typeof data.audit_view === "object" ? (data.audit_view as AuditView) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strategyType(row: Record<string, unknown>): string {
  return String(row.strategy_type || row.strategyType || "");
}

function surfacesOf(row: Record<string, unknown>): string[] {
  const raw = row.surfaces;
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

function evalReady(data: Record<string, unknown>, id: string): { ready: boolean; reason: string } {
  const lab = rec(data.atlaslab);
  const model = rec(lab.model);
  const live = rec(model.live_eval);
  if (id === "deterministic") {
    const suite = rec(rec(lab.deterministic).suite);
    const ready = suite.ready === true || rec(lab.deterministic).ready === true;
    return { ready, reason: String(suite.reason || rec(lab.deterministic).reason || "") };
  }
  if (id === "compatibility") {
    const row = rec(live.agent_compatibility);
    return { ready: row.ready === true, reason: String(row.reason || "") };
  }
  const row = rec(live.commercial_uplift);
  return { ready: row.ready === true, reason: String(row.reason || "") };
}

export function Dashboard({ data }: { data: Record<string, unknown> }) {
  const merchant = audit(data)?.merchant;
  const profile = merchant?.profile.value;
  const products = merchant?.products.value;
  const inventory = merchant?.inventory.value;
  const locations = merchant?.locations.value;
  const strategies = merchant?.strategies.value ?? [];
  const suites = (Array.isArray(data.lab_examples) ? data.lab_examples : []) as LabExampleSuite[];
  const name = profile ? String(profile.display_name ?? "Display name missing") : "Merchant profile unavailable";
  const description = text(profile?.description);
  const city = text(profile?.city);
  const country = text(profile?.country);
  const support = text(profile?.support_email);
  const legal = text(profile?.legal_name);

  return (
    <>
      <UpstreamNotice data={data} />

      <section data-testid="merchant-data">
        <div className="status-bar">
          <article className="status-cell" data-evidence-state={merchant?.profile.state ?? "unavailable"}>
            <p className="kicker">{evidenceLabel(merchant?.profile.state ?? "unavailable")}</p>
            <h3 data-testid="merchant-name">{name}</h3>
            <p>
              {profile
                ? [legal, city && country ? `${city}, ${country}` : city || country, profile.currency]
                    .filter(Boolean)
                    .join(" · ") || "No profile detail."
                : "No live profile payload."}
            </p>
          </article>
          <div className="status-cell">
            <p className="kicker">Catalog</p>
            <p className="value">{products ? String(products.length) : "—"}</p>
            <p data-testid="missing-catalog">
              {products
                ? `${products.length} live products loaded.`
                : `Catalog ${merchant?.products.state ?? "unavailable"} — not replaced with fixtures.`}
            </p>
          </div>
          <div className="status-cell">
            <p className="kicker">Locations</p>
            <p className="value">{locations ? String(locations.length) : "—"}</p>
            <p className="muted">{inventory ? `${inventory.length} inventory rows` : "Inventory not loaded."}</p>
          </div>
        </div>

        {description ? <p className="lede">{description}</p> : null}
        {support ? <p className="footnote">Support {support}</p> : null}

        <Section title="Locations" hint="Dark stores this reference merchant can fulfil from.">
          <DataTable rows={locations ?? []} cols={["location_id", "name"]} />
        </Section>

        <ToggleSection title="Products" hint={`${products?.length ?? 0} live`}>
          {products?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Name</th>
                    <th>Brand</th>
                    <th>Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {products.slice(0, 24).map((row, i) => (
                    <tr key={String(row.product_id ?? i)}>
                      <td className="id">{row.product_id ? <CodeChip value={String(row.product_id)} /> : "—"}</td>
                      <td>{String(row.name ?? "—")}</td>
                      <td>{String(row.brand ?? "—")}</td>
                      <td>
                        <StatusMark state="ready" label="Live" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title={products ? "No products yet." : "Catalog unavailable."}
              detail={
                products
                  ? "Catalog rows appear after Core loads live SKUs."
                  : "Missing values stay blank. They are never shown as zero."
              }
            />
          )}
        </ToggleSection>
      </section>

      <section data-testid="confirmed-orders">
        <Section title="Confirmed orders" hint="Fixture checkout tickets for the demo. Not live Razorpay capture or settlement.">
          <div className="status-bar">
            <article className="status-cell" data-evidence-state="measured">
              <p className="kicker">Readiness</p>
              <p className="value">4 / 4</p>
              <p>Inventory, quote, location, and payment intent.</p>
            </article>
            <article className="status-cell" data-evidence-state="measured">
              <p className="kicker">Confirmed order</p>
              <p className="value" data-testid="confirmed-order-count">
                {DEMO_CONFIRMED_ORDERS.length}
              </p>
              <p>Test Mode orders with Core confirmation.</p>
            </article>
            <article className="status-cell" data-evidence-state="test_mode_only">
              <p className="kicker">Payment assurance</p>
              <p className="value">Captured</p>
              <p>Provider fetch evidence. Checkout screens are not truth.</p>
            </article>
          </div>

          <div className="order-list">
            {DEMO_CONFIRMED_ORDERS.map((order) => (
              <article className="card order-card" key={order.merchant_order_id} data-testid={`order-${order.merchant_order_id}`}>
                <div className="order-card-head">
                  <div>
                    <p className="kicker">Fixture ticket</p>
                    <h3>
                      <CodeChip value={order.merchant_order_id} />
                    </h3>
                  </div>
                  <div className="order-card-meta">
                    <StatusMark state="confirmed" label="Confirmed order" />
                    <p className="value">{formatInrMinor(order.amount_minor) ?? "—"}</p>
                    <p className="muted">{formatWhen(order.confirmed_at)}</p>
                  </div>
                </div>
                <div className="status-bar tight">
                  <div className="status-cell" data-evidence-state="measured">
                    <p className="kicker">Readiness</p>
                    <p className="value">{order.readiness.score}</p>
                    <ul className="gate-list">
                      {order.readiness.gates.map((gate) => (
                        <li key={gate.label}>
                          <StatusMark state={gate.state} label={gate.label} />
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="status-cell" data-evidence-state="measured">
                    <p className="kicker">Confirmed order</p>
                    <p>{order.items.join(" · ")}</p>
                    <p className="muted">{order.location}</p>
                    <p>
                      <StatusMark state="confirmed" label={humanize(order.status)} />
                    </p>
                  </div>
                  <div className="status-cell" data-evidence-state={order.payment.evidence_status === "PARTIAL" ? "partial" : "measured"}>
                    <p className="kicker">Payment assurance</p>
                    <p>
                      <StatusMark state={order.payment.evidence_status.toLowerCase()} label={humanize(order.payment.final_state)} />
                    </p>
                    <p>
                      <CodeChip value={order.payment.provider_payment_id} />
                    </p>
                    <p className="muted">
                      Amount {order.payment.amount_match} · webhook {order.payment.webhook_bound ? "bound" : "pending"} ·{" "}
                      {order.payment.evidence_digest}
                    </p>
                    <p className="muted">{order.payment.message}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </Section>
      </section>

      <section data-testid="commerce-strategies">
        <Section title="Commerce strategies" hint="Merchant-controlled offers. Exploratory surfaces are not the public growth claim.">
          {strategies.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Status</th>
                    <th>Visibility</th>
                    <th>Surfaces</th>
                    <th>Buyer-facing rule</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.map((row, i) => {
                    const type = strategyType(row);
                    const enabled = row.enabled === true || row.enabled === "true";
                    const visibility = String(row.visibility || "EXPLORATORY");
                    const surfaces = surfacesOf(row);
                    return (
                      <tr key={type || String(i)}>
                        <td>
                          {humanize(type || "—")}
                          {type ? (
                            <>
                              {" "}
                              <CodeChip value={type} />
                            </>
                          ) : null}
                        </td>
                        <td>
                          <StatusMark state={enabled ? "ready" : "unavailable"} label={enabled ? "On" : "Off"} />
                        </td>
                        <td>
                          <StatusMark
                            state={visibility.toLowerCase() === "demo" ? "measured" : "partial"}
                            label={humanize(visibility)}
                          />
                        </td>
                        <td>
                          {surfaces.length ? (
                            <span className="cluster-inline">
                              {surfaces.map((surface) => (
                                <CodeChip key={surface} value={surface} />
                              ))}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{strategyBlurb(type)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No commercial strategies loaded."
              detail="Strategy rows appear after Core returns merchant-controlled offer types."
            />
          )}
        </Section>
      </section>

      <section data-testid="atlaslab-framework">
        <Section title="AtlasLab evaluation framework" hint="Numbers below are a fixture sitting. Use Run eval to start a live AtlasLab report. Compatibility and commercial evals can take several minutes.">
          <div className="status-bar" data-testid="eval-numbers">
            {LAB_EVALS.map((evalKind) => {
              const state = evalReady(data, evalKind.id);
              const known = Boolean(rec(data.atlaslab).deterministic || rec(data.atlaslab).model);
              const numbers = FIXTURE_EVAL_NUMBERS[evalKind.id];
              return (
                <article key={evalKind.id} className="status-cell" data-evidence-state={known ? (state.ready ? "measured" : "partial") : "unavailable"}>
                  <p className="kicker">{known ? (state.ready ? "Ready" : "Not ready") : "Fixture sitting"}</p>
                  <h3>{evalKind.title}</h3>
                  <p className="value" data-testid={`eval-score-${evalKind.id}`}>
                    {numbers.value}
                  </p>
                  <p>
                    Score {numbers.score} · {numbers.caption}
                  </p>
                  <p>{evalKind.detail}</p>
                  <p>
                    <CodeChip value={evalKind.path} />
                  </p>
                  <EvalRunButton id={evalKind.id} kind={evalKind.id} label="Run eval" />
                  {state.reason ? <p className="muted">{state.reason}</p> : null}
                </article>
              );
            })}
          </div>

          {suites.map((suite) => (
            <div className="lab-suite" key={suite.id}>
              <div className="lab-suite-head">
                <h3>{suite.title}</h3>
                <p className="muted">{suite.hint}</p>
                {suite.evalKind === "custom" ? null : (
                  <EvalRunButton id={`suite-${suite.id}`} kind={suite.evalKind} label="Run suite" />
                )}
              </div>
              <ul className="mission-list">
                {suite.tests.map((test) => (
                  <li key={test.id}>
                    <div className="mission-head">
                      <div className="attention-meta">
                        <StatusMark state="measured" label={test.result} />
                        <span className="chip chip-fixture" data-testid={`eval-test-score-${test.id}`}>
                          {test.score}
                        </span>
                        <CodeChip value={test.id} />
                      </div>
                      <EvalRunButton id={`test-${test.id}`} kind="custom" prompt={test.prompt} label="Run test" />
                    </div>
                    <h4>{test.title}</h4>
                    <p>{test.prompt}</p>
                    <p className="muted">Expected: {test.expected}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      </section>
    </>
  );
}

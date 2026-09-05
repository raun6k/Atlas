import { CLAIM_BANNER, DEFENSIBLE_CLAIMS, NOT_CLAIMED, EVIDENCE_LEVELS } from "./claims";
import { metricFromOutcome, type EvidenceMetric } from "./evidence";
import { MOCK_CONSOLE, MOCK_REPORT } from "./mocks";
import { projectAuditView } from "./audit-view";
import { adminGet, labGet, asList, asRecord } from "./upstream";

export type Screen = "home" | "sellability" | "growth" | "commerce" | "merchant" | "trust" | "system" | "demo";

function mocksOn(): boolean {
  return process.env.ATLAS_FRONTEND_ENABLE_MOCKS === "1";
}

export async function loadScreen(screen: Screen): Promise<Record<string, unknown>> {
  const base = {
    claims: { banner: CLAIM_BANNER, defensible: DEFENSIBLE_CLAIMS, not_claimed: NOT_CLAIMED, levels: EVIDENCE_LEVELS },
    test_mode: true,
  };
  if (mocksOn()) {
    const mockAuditView = projectAuditView({
      source: "mock",
      reports: { items: [
        { kind: "CONTRACT", report_id: "mock_contract", report: { contract_version: "atlas.merchant.v1" } },
        { kind: "AGENT_COMPATIBILITY", report_id: "mock_compatibility", report: { evidence_level: "fabric-tested" } },
        { kind: "COMMERCIAL_UPLIFT", report_id: "mock_commercial", report: MOCK_REPORT },
      ] },
      profile: { profile: MOCK_CONSOLE.merchant.profile },
      locations: MOCK_CONSOLE.merchant.locations,
      products: [],
      inventory: [],
      strategies: MOCK_CONSOLE.merchant.strategies,
      attention: MOCK_CONSOLE.home.attention,
      payments: MOCK_CONSOLE.trust.payments.map((assurance) => ({ assurance })),
      audit: MOCK_CONSOLE.trust.audit,
    });
    return {
      ...base,
      mock: true,
      screen,
      ...(MOCK_CONSOLE as Record<string, unknown>),
      attention: MOCK_CONSOLE.home.attention,
      latest_order: MOCK_CONSOLE.home.latest_order,
      payment_assurance: MOCK_CONSOLE.trust.payments[0],
      report: MOCK_REPORT,
      audit_view: mockAuditView,
    };
  }
  try {
    const data = await loadLive(screen);
    return {
      ...base,
      mock: false,
      screen,
      ...data,
      audit_view: projectAuditView({ source: "live", ...data }),
    };
  } catch (err) {
    const error = {
      state: "unavailable",
      message: err instanceof Error ? err.message : "upstream unavailable — values are not zero",
    };
    return {
      ...base,
      mock: false,
      screen,
      error,
      audit_view: projectAuditView({ source: "live", error }),
    };
  }
}

async function loadLive(screen: Screen): Promise<Record<string, unknown>> {
  if (screen === "home" || screen === "demo") {
    const [attention, outcomes, orders, health, reports] = await Promise.all([
      adminGet("/admin/v1/trust/attention"),
      adminGet("/admin/v1/merchant/outcomes"),
      adminGet("/admin/v1/commerce/orders"),
      adminGet("/admin/v1/system/health"),
      labGet("/lab/v1/reports"),
    ]);
    const orderList = asList(orders.body, ["orders"]);
    const latest = (orderList[0] ?? null) as Record<string, unknown> | null;
    let assurance = null;
    if (latest?.merchant_order_id) {
      const detail = await adminGet(`/admin/v1/commerce/orders/${encodeURIComponent(String(latest.merchant_order_id))}`);
      assurance = asRecord(asRecord(detail.body).envelope).correlation ?? null;
    }
    return {
      attention: asRecord(attention.body),
      outcomes: metrics(outcomes.body),
      latest_order: latest,
      payment_assurance: assurance,
      health: asRecord(health.body),
      reports: reports.body,
    };
  }
  if (screen === "sellability") {
    const [caps, reports, analytics] = await Promise.all([
      adminGet("/admin/v1/system/capabilities"),
      labGet("/lab/v1/reports"),
      labGet("/lab/v1/analytics/sellability"),
    ]);
    return {
      capabilities: asRecord(caps.body),
      reports: reports.body,
      analytics: asRecord(analytics.body),
    };
  }
  if (screen === "growth") {
    const [reports, experiments, outcomes] = await Promise.all([
      labGet("/lab/v1/reports"),
      labGet("/lab/v1/analytics/experiments"),
      adminGet("/admin/v1/merchant/outcomes"),
    ]);
    return {
      reports: reports.body,
      experiments: asRecord(experiments.body),
      outcomes: metrics(outcomes.body),
    };
  }
  if (screen === "commerce") {
    const [sessions, offers, orders] = await Promise.all([
      adminGet("/admin/v1/commerce/sessions"),
      adminGet("/admin/v1/commerce/offers"),
      adminGet("/admin/v1/commerce/orders"),
    ]);
    return {
      sessions: asList(sessions.body, ["sessions"]),
      offers: asList(offers.body, ["offers"]),
      orders: asList(orders.body, ["orders"]),
      substitutions: { label: "future", message: "Substitution is not on the public MCP contract." },
      refunds: { label: "future", message: "Refund execution is not claimed as settlement." },
    };
  }
  if (screen === "merchant") {
    const [profile, locations, products, inventory, promotions, strategies] = await Promise.all([
      adminGet("/admin/v1/merchant/profile"),
      adminGet("/admin/v1/merchant/locations"),
      adminGet("/admin/v1/merchant/products"),
      adminGet("/admin/v1/merchant/inventory"),
      adminGet("/admin/v1/merchant/promotions"),
      adminGet("/admin/v1/merchant/strategies"),
    ]);
    return {
      profile: asRecord(profile.body),
      locations: locations.body,
      products: products.body,
      inventory: inventory.body,
      promotions: promotions.body,
      strategies: strategies.body,
    };
  }
  if (screen === "trust") {
    const [attention, orders, events, outcomes] = await Promise.all([
      adminGet("/admin/v1/trust/attention"),
      adminGet("/admin/v1/commerce/orders"),
      adminGet("/admin/v1/audit/events"),
      adminGet("/admin/v1/merchant/outcomes"),
    ]);
    const orderList = asList(orders.body, ["orders"]) as Array<Record<string, unknown>>;
    const payments = [];
    for (const order of orderList.slice(0, 8)) {
      if (!order.merchant_order_id) continue;
      const detail = await adminGet(`/admin/v1/commerce/orders/${encodeURIComponent(String(order.merchant_order_id))}`);
      payments.push({
        order,
        detail: detail.body,
      });
    }
    return {
      attention: attention.body,
      payments: orders.ok ? payments : orders.body,
      audit: events.body,
      outcomes: metrics(outcomes.body),
    };
  }
  const [health, caps, labCaps] = await Promise.all([
    adminGet("/admin/v1/system/health"),
    adminGet("/admin/v1/system/capabilities"),
    labGet("/lab/v1/capabilities"),
  ]);
  return {
    health: asRecord(health.body),
    capabilities: asRecord(caps.body),
    atlaslab: asRecord(labCaps.body),
  };
}

function metrics(body: unknown): EvidenceMetric[] {
  return asList(body, ["metrics"]).map((row) => metricFromOutcome(asRecord(row)));
}

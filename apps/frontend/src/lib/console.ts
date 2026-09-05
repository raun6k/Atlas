import { EXAMPLE_LAB_TESTS } from "./lab-examples";
import { MOCK_CONSOLE } from "./mocks";
import { projectAuditView } from "./audit-view";
import { adminGet, asRecord, labGet } from "./upstream";

function mocksOn(): boolean {
  return process.env.ATLAS_FRONTEND_ENABLE_MOCKS === "1";
}

export async function loadDashboard(): Promise<Record<string, unknown>> {
  const base = {
    test_mode: true,
    lab_examples: EXAMPLE_LAB_TESTS,
  };
  if (mocksOn()) {
    return {
      ...base,
      mock: true,
      ...(MOCK_CONSOLE as Record<string, unknown>),
      audit_view: projectAuditView({
        source: "mock",
        profile: { profile: MOCK_CONSOLE.merchant.profile },
        locations: MOCK_CONSOLE.merchant.locations,
        products: MOCK_CONSOLE.merchant.products,
        inventory: MOCK_CONSOLE.merchant.inventory,
        strategies: MOCK_CONSOLE.merchant.strategies,
      }),
    };
  }
  try {
    const data = await loadLive();
    return {
      ...base,
      mock: false,
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
      error,
      audit_view: projectAuditView({ source: "live", error }),
    };
  }
}

async function loadLive(): Promise<Record<string, unknown>> {
  const [profile, locations, products, inventory, strategies, atlaslab] = await Promise.all([
    adminGet("/admin/v1/merchant/profile"),
    adminGet("/admin/v1/merchant/locations"),
    adminGet("/admin/v1/merchant/products"),
    adminGet("/admin/v1/merchant/inventory"),
    adminGet("/admin/v1/merchant/strategies"),
    labGet("/lab/v1/capabilities"),
  ]);
  return {
    profile: asRecord(profile.body),
    locations: locations.body,
    products: products.body,
    inventory: inventory.body,
    strategies: strategies.body,
    atlaslab: asRecord(atlaslab.body),
  };
}

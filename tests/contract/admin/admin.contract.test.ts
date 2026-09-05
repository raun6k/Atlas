const fs = require("fs");
const path = require("path");
const yaml = fs.readFileSync(path.join(__dirname, "../../../schemas/openapi/admin.yaml"), "utf8");

const GATEWAY_ADMIN_PATHS = [
  "/admin/v1/merchant/profile",
  "/admin/v1/merchant/locations",
  "/admin/v1/merchant/products",
  "/admin/v1/merchant/products/{product_id}",
  "/admin/v1/merchant/inventory",
  "/admin/v1/merchant/inventory/adjustments",
  "/admin/v1/merchant/relationships",
  "/admin/v1/merchant/promotions",
  "/admin/v1/merchant/promotions/{promotion_id}",
  "/admin/v1/merchant/strategies",
  "/admin/v1/merchant/rules/preview",
  "/admin/v1/commerce/sessions",
  "/admin/v1/commerce/sessions/{session_id}",
  "/admin/v1/commerce/offers",
  "/admin/v1/commerce/offers/{offer_id}",
  "/admin/v1/commerce/orders",
  "/admin/v1/commerce/orders/{merchant_order_id}",
  "/admin/v1/trust/attention",
  "/admin/v1/merchant/outcomes",
  "/admin/v1/trust/hosts",
  "/admin/v1/search",
  "/admin/v1/audit/events",
  "/admin/v1/audit/events/{audit_event_id}",
  "/admin/v1/audit/exports",
  "/admin/v1/operations",
  "/admin/v1/operations/{operation_id}",
  "/admin/v1/operations/{operation_id}/reconcile",
  "/admin/v1/system/capabilities",
  "/admin/v1/system/health",
  "/admin/v1/system/outcomes",
];

const documented = [...yaml.matchAll(/^  (\/admin\/v1\/[^\s:]+):$/gm)].map((m) => m[1]);
for (const p of GATEWAY_ADMIN_PATHS) {
  if (!documented.includes(p)) throw new Error("openapi missing Gateway path " + p);
}
for (const p of documented) {
  if (!GATEWAY_ADMIN_PATHS.includes(p)) throw new Error("openapi documents unimplemented path " + p);
}
if (yaml.includes("/admin/v1/merchant/locations/{location_id}")) throw new Error("location-by-id is not on Gateway");
if (yaml.includes("/admin/v1/merchant/skus")) throw new Error("list SKUs is not on Gateway");
if (!yaml.includes("operatorBearer")) throw new Error("missing operatorBearer");
if (!yaml.includes("expected_version")) throw new Error("missing expected_version");
if (!yaml.includes("x-required-scopes")) throw new Error("missing required scopes");
console.log("admin openapi contract: ok");

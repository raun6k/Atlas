const HEADINGS: Record<string, string> = {
  session_id: "Session",
  merchant_order_id: "Order",
  payment_public_status: "Payment",
  product_id: "Product",
  sku_id: "SKU",
  location_id: "Location",
  sellable_quantity: "Sellable",
  stock_status: "Stock",
  strategy_type: "Strategy",
  offer_id: "Offer",
  grounded_reason: "Grounded reason",
  display_name: "Merchant",
  lifecycle: "Lifecycle",
  stage: "Stage",
  passed: "Passed",
  eligible: "Eligible",
  exclusions: "Excluded",
  status: "Status",
  mission: "Mission",
  name: "Name",
  brand: "Brand",
};

export function headingize(key: string): string {
  if (HEADINGS[key]) return HEADINGS[key];
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatWhen(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "unavailable";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatInrMinor(minor: unknown): string | null {
  if (typeof minor !== "number" || Number.isNaN(minor)) return null;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

export function flagOn(value: unknown): boolean {
  return value === true || value === "true";
}

export function asText(value: unknown, fallback = "unavailable"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

const HUMAN: Record<string, string> = {
  CAPTURED_RECONCILED: "Captured",
  FAILED_VERIFIED: "Failed — verified",
  CANCELLED_VERIFIED: "Cancelled — verified",
  PAYMENT_FAILED_VERIFIED: "Payment failed — verified",
  OUTCOME_UNKNOWN: "Outcome unknown",
  UNRESOLVED_MONEY: "Unresolved money",
  INCOMPLETE_MERCHANT_DATA: "Incomplete merchant data",
  PROVIDER_EVIDENCE_EVALUATED: "Provider evidence evaluated",
  FREE_DELIVERY: "Free delivery",
  SMALL_ORDER: "Small order",
  BRAND_PROMO: "Brand promo",
  FBT: "Frequently bought together",
  DEMO: "Demo",
  EXPLORATORY: "Exploratory",
  NOT_IMPLEMENTED: "Not implemented",
  CONFIRMED: "Confirmed",
  OPEN: "Open",
  HIGH: "High",
  PARTIAL: "Partial",
  READY: "Ready",
  AVAILABLE: "Measured",
  UNAVAILABLE: "Unavailable",
  UNPROVEN: "Unproven",
  UNKNOWN: "Unknown",
  MEASURED: "Measured",
  UNRESOLVED: "Unresolved",
  MISSING: "Missing",
  INELIGIBLE: "Ineligible",
  SIMULATED: "Simulated",
  TEST_MODE_ONLY: "Test Mode only",
};

export function looksLikeEnum(value: string): boolean {
  if (!value) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return true;
  return value.length >= 3 && /^[A-Z][A-Z0-9]*$/.test(value);
}

/** Operator-facing English for machine enumerations. IDs are left unchanged. */
export function humanize(value: unknown, fallback = "unavailable"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const mapped = HUMAN[raw] ?? HUMAN[raw.toUpperCase()];
  if (mapped) return mapped;
  if (looksLikeEnum(raw)) {
    const words = raw.toLowerCase().replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(raw) && !/^(ord_|pat_|ses_|off_|loc_|pay_|evt_|sku_|cpo_|run_)/.test(raw)) {
    const words = raw.replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return raw;
}

export function displayCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return humanize(value, "—");
}

export function numericCol(key: string): boolean {
  return /quantity|passed|eligible|exclusions|count|amount|pairs|minor/i.test(key);
}

export function idCol(key: string): boolean {
  return /_id$|^sku_id$|^session_id$/.test(key);
}

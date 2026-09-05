import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ORACLE_FEE_SPEC_VERSION = "eval_fees_v1";
export const SUITE_SCENARIO_ID = "suite_qm_v1";
export const SUITE_PROGRAM_ID = "ap_suite_qm_v1";
export const DEFAULT_LOCATION_ID = "loc_qm_koramangala";
export const DEFAULT_SERVICEABILITY = "blr_koramangala_5th_block";
export const BANANA_SKU = "QM-FPR-0061-A";
export const BANANA_QUERY = "robusta banana";
export const BEV_SKU = "QM-BEV-0031-A";
export const BEV_PROMO_ID = "promo_qm_bev_basket_02";
export const PRODUCE_PROMO_ID = "promo_qm_fpr_basket_03";

export interface MerchantFees {
  currency: string;
  prices_include_tax: boolean;
  base_delivery_fee_minor: number;
  minimum_order_value_minor: number;
  small_order_threshold_minor: number;
  small_order_fee_minor: number;
  fee_after_small_order_threshold_minor: number;
  free_delivery_threshold_minor: number;
  delivery_fee_after_threshold_minor: number;
  base_handling_fee_minor: number;
}

export interface LocationOffer {
  location_id: string;
  sku_id: string;
  assorted: boolean;
  mrp_minor: number;
  selling_price_minor: number;
  on_hand_quantity: number;
  reserved_quantity: number;
  safety_buffer: number;
}

export interface SkuRecord {
  sku_id: string;
  product_id: string;
  name: string;
  variant_label: string;
  net_quantity: number;
}

export interface ProductRecord {
  product_id: string;
  name: string;
  brand: string;
  category: string;
  dietary_tags: string[];
  allergen_tags: string[];
  search_tokens: string[];
}

export interface FixturePromotion {
  promotion_id: string;
  promotion_type: string;
  application_mode: string;
  enabled: boolean;
  eligible_sku_ids: string[];
  location_ids: string[];
  minimum_quantity: number;
  minimum_cart_value_minor: number;
  discount_amount_minor: number;
  benefit_type: string;
  starts_at: string;
  ends_at: string;
}

export interface FixtureWorld {
  snapshot_id: string;
  digest: string;
  fees: MerchantFees;
  offers: LocationOffer[];
  skus: Map<string, SkuRecord>;
  products: Map<string, ProductRecord>;
  promotions: FixturePromotion[];
}

export function defaultFixtureDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const env = process.env.ATLAS_FIXTURE_DIR;
  const candidates = [
    env ? join(process.cwd(), env) : "",
    env ?? "",
    join(here, "../../../../db/atlas/fixtures/quickmart-v1"),
    join(process.cwd(), "db/atlas/fixtures/quickmart-v1"),
    join(process.cwd(), "../../db/atlas/fixtures/quickmart-v1"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "merchant.json"))) ?? candidates[candidates.length - 1]!;
}

export function sellableQuantity(onHand: number, reserved: number, buffer: number): number {
  const v = onHand - reserved - buffer;
  return v > 0 ? v : 0;
}

export function isDiscoverable(offer: LocationOffer): boolean {
  return offer.assorted && sellableQuantity(offer.on_hand_quantity, offer.reserved_quantity, offer.safety_buffer) > 0;
}

export function loadFixtureWorld(dir = defaultFixtureDir()): FixtureWorld {
  const merchant = JSON.parse(readFileSync(join(dir, "merchant.json"), "utf8")) as Record<string, unknown>;
  const fees: MerchantFees = {
    currency: String(merchant.default_currency ?? "INR"),
    prices_include_tax: Boolean(merchant.prices_include_tax),
    base_delivery_fee_minor: num(merchant.base_delivery_fee_minor),
    minimum_order_value_minor: num(merchant.minimum_order_value_minor),
    small_order_threshold_minor: num(merchant.small_order_threshold_minor),
    small_order_fee_minor: num(merchant.small_order_fee_minor),
    fee_after_small_order_threshold_minor: num(merchant.fee_after_small_order_threshold_minor),
    free_delivery_threshold_minor: num(merchant.free_delivery_threshold_minor),
    delivery_fee_after_threshold_minor: num(merchant.delivery_fee_after_threshold_minor),
    base_handling_fee_minor: num(merchant.base_handling_fee_minor),
  };
  const offers = parseCsv(readFileSync(join(dir, "location_sku_offers.csv"), "utf8")).map((row) => ({
    location_id: row.location_id ?? "",
    sku_id: row.sku_id ?? "",
    assorted: row.assorted === "true",
    mrp_minor: Number(row.mrp_minor),
    selling_price_minor: Number(row.selling_price_minor),
    on_hand_quantity: Number(row.on_hand_quantity),
    reserved_quantity: Number(row.reserved_quantity || 0),
    safety_buffer: Number(row.safety_buffer || 0),
  }));
  const skus = new Map<string, SkuRecord>();
  for (const row of parseCsv(readFileSync(join(dir, "skus.csv"), "utf8"))) {
    const skuId = row.sku_id ?? "";
    skus.set(skuId, {
      sku_id: skuId,
      product_id: row.product_id ?? "",
      name: row.name ?? "",
      variant_label: row.variant_label ?? "",
      net_quantity: num(row.net_quantity),
    });
  }
  const products = new Map<string, ProductRecord>();
  for (const row of parseCsv(readFileSync(join(dir, "products.csv"), "utf8"))) {
    let tokens: string[] = [];
    try {
      const parsed = JSON.parse(row.aliases_json || "[]");
      if (Array.isArray(parsed)) tokens = parsed.map(String);
    } catch {
      tokens = [];
    }
    const productId = row.product_id ?? "";
    products.set(productId, {
      product_id: productId,
      name: row.name ?? "",
      brand: row.brand ?? "",
      category: row.category ?? "",
      dietary_tags: jsonStringArray(row.dietary_tags_json),
      allergen_tags: jsonStringArray(row.allergen_tags_json),
      search_tokens: tokens,
    });
  }
  const promotions = (JSON.parse(readFileSync(join(dir, "promotions.json"), "utf8")) as Array<Record<string, unknown>>).map(
    (p) => ({
      promotion_id: String(p.promotion_id),
      promotion_type: String(p.promotion_type ?? ""),
      application_mode: String(p.application_mode ?? ""),
      enabled: Boolean(p.enabled),
      eligible_sku_ids: Array.isArray(p.eligible_sku_ids) ? p.eligible_sku_ids.map(String) : [],
      location_ids: Array.isArray(p.location_ids) ? p.location_ids.map(String) : [],
      minimum_quantity: num((p.condition as Record<string, unknown> | undefined)?.minimum_quantity),
      minimum_cart_value_minor: num((p.condition as Record<string, unknown> | undefined)?.minimum_cart_value_minor),
      discount_amount_minor: num((p.benefit as Record<string, unknown> | undefined)?.discount_amount_minor),
      benefit_type: String((p.benefit as Record<string, unknown> | undefined)?.type ?? ""),
      starts_at: String(p.starts_at ?? ""),
      ends_at: String(p.ends_at ?? ""),
    }),
  );
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    snapshot_id?: string;
    files: Array<{ path: string; sha256?: string }>;
  };
  return {
    snapshot_id: String(manifest.snapshot_id ?? "fix_quickmart_v1"),
    digest: contentDigest(dir, fees.currency, manifest.files),
    fees,
    offers,
    skus,
    products,
    promotions,
  };
}

export function offerAt(world: FixtureWorld, locationId: string, skuId: string): LocationOffer | undefined {
  return world.offers.find((o) => o.location_id === locationId && o.sku_id === skuId);
}

export function productForSku(world: FixtureWorld, skuId: string): ProductRecord | undefined {
  const sku = world.skus.get(skuId);
  if (!sku) return undefined;
  return world.products.get(sku.product_id);
}

function contentDigest(dir: string, currency: string, files: Array<{ path: string; sha256?: string }>): string {
  const h = createHash("sha256");
  h.update(`currency:${currency}\n`);
  for (const f of files) {
    const b = readFileSync(join(dir, f.path));
    const sum = createHash("sha256").update(b).digest();
    const got = sum.toString("hex");
    if (f.sha256 && f.sha256.toLowerCase() !== got) {
      throw new Error(`manifest hash mismatch for ${f.path}`);
    }
    h.update(f.path);
    h.update(sum);
  }
  return `sha256:${h.digest("hex")}`;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

function jsonStringArray(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur.replace(/\r$/, ""));
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur.replace(/\r$/, ""));
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows.map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = cells[idx] ?? "";
    });
    return rec;
  });
}

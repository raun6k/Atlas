import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { handleRazorpayWebhook } from "./webhooks/razorpay/http.js";
import { handleRunnerRequest } from "./internal/test-runner/http.js";
import { mcpOk } from "./mcp-map.js";
import { mcpRpcError, publicAdminError } from "./grpc-error.js";
import { publicInputSchema, validateToolArguments } from "./mcp-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const protoPath = join(repoRoot, "proto/atlas/merchant/v1/merchant.proto");
const coreAddr = process.env.ATLAS_CORE_GRPC_ADDR ?? "127.0.0.1:9090";
const listen = process.env.ATLAS_GATEWAY_HTTP_ADDR ?? "127.0.0.1:8080";
const def = protoLoader.loadSync(protoPath, { keepCase: false, longs: String, enums: String, defaults: true });
const pkg = grpc.loadPackageDefinition(def) as any;
const query = new pkg.atlas.merchant.v1.MerchantQueryService(coreAddr, grpc.credentials.createInsecure());
const sessions = new pkg.atlas.merchant.v1.SessionService(coreAddr, grpc.credentials.createInsecure());
const carts = new pkg.atlas.merchant.v1.CartService(coreAddr, grpc.credentials.createInsecure());
const checkout = new pkg.atlas.merchant.v1.CheckoutService(coreAddr, grpc.credentials.createInsecure());
const admin = new pkg.atlas.merchant.v1.AdminService(coreAddr, grpc.credentials.createInsecure());
const audit = new pkg.atlas.merchant.v1.AuditService(coreAddr, grpc.credentials.createInsecure());
const fixtures = new pkg.atlas.merchant.v1.FixtureService(coreAddr, grpc.credentials.createInsecure());
const fabric = new pkg.atlas.merchant.v1.PaymentFabricService(coreAddr, grpc.credentials.createInsecure());
const coreHttp = process.env.ATLAS_CORE_HTTP_ADDR ?? "http://127.0.0.1:9091";
const coreHttpOrigin = coreHttp.includes("://") ? coreHttp : `http://${coreHttp}`;

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

const PUBLIC_TOOLS = new Set([
  "get_capabilities", "create_session", "set_intent", "search_catalog", "get_product",
  "get_cart", "add_cart_item", "update_cart_item", "remove_cart_item",
  "apply_offer", "prepare_checkout", "complete_checkout",
  "get_order",
]);

const MUTATIONS = new Set([
  "create_session", "set_intent", "add_cart_item", "update_cart_item", "remove_cart_item",
  "apply_offer", "prepare_checkout", "complete_checkout",
]);

const MAX_BODY_BYTES = 1_048_576;

function grpcMeta(req: IncomingMessage): grpc.Metadata {
  const md = new grpc.Metadata();
  const token = bearer(req);
  if (token) md.set("authorization", `Bearer ${token}`);
  return md;
}

function fabricMeta(kind: "webhook" | "runner"): grpc.Metadata {
  const md = new grpc.Metadata();
  const token =
    kind === "webhook"
      ? process.env.ATLAS_PAYMENT_FABRIC_BEARER || process.env.RAZORPAY_WEBHOOK_SECRET || ""
      : process.env.ATLAS_RUNNER_EXECUTOR_CREDENTIAL || "";
  if (token) md.set("authorization", `Bearer ${token}`);
  return md;
}

function promisify(client: any, method: string, req: unknown, md?: grpc.Metadata): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](req, md ?? new grpc.Metadata(), (err: grpc.ServiceError, res: unknown) => (err ? reject(err) : resolve(res)));
  });
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    n += buf.length;
    if (n > limit) {
      throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { code: "PAYLOAD_TOO_LARGE" });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, code: number, body: unknown, requestId = "") {
  let payload: unknown = body;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rec = payload as Record<string, unknown>;
    if (!("jsonrpc" in rec) && rec.request_id === undefined && rec.requestId === undefined) {
      payload = { request_id: requestId, ...rec };
    }
  }
  const data = JSON.stringify(payload);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
}

function parseAdminBody(raw: string, allowed: string[]): Record<string, unknown> {
  const body = JSON.parse(raw || "{}") as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("INVALID_ARGUMENT"), { code: "INVALID_ARGUMENT" });
  }
  const rec = body as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) {
      throw Object.assign(new Error("INVALID_ARGUMENT"), { code: "INVALID_ARGUMENT" });
    }
  }
  return rec;
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function authenticateHost(token: string): Promise<string> {
  const res = await fetch(`${coreHttpOrigin}/internal/v1/authenticate-host`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw Object.assign(new Error("HOST_UNAUTHENTICATED"), { code: "HOST_UNAUTHENTICATED" });
  }
  const body = (await res.json()) as { host_id?: string };
  if (!body.host_id) {
    throw Object.assign(new Error("HOST_UNAUTHENTICATED"), { code: "HOST_UNAUTHENTICATED" });
  }
  return body.host_id;
}

async function authenticateOperator(token: string): Promise<{ operatorId: string; operatorScopes: string[] }> {
  const res = await fetch(`${coreHttpOrigin}/internal/v1/authenticate-operator`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw Object.assign(new Error("UNAUTHENTICATED"), { code: "UNAUTHENTICATED" });
  }
  const body = (await res.json()) as { operator_id?: string; scopes?: string[] };
  if (!body.operator_id) {
    throw Object.assign(new Error("UNAUTHENTICATED"), { code: "UNAUTHENTICATED" });
  }
  return { operatorId: body.operator_id, operatorScopes: Array.isArray(body.scopes) ? body.scopes : [] };
}

function atlasMeta(req: IncomingMessage, extra: Record<string, unknown>, hostId = ""): any {
  const requestId = (req.headers["x-request-id"] as string) || (extra.request_id as string) || crypto.randomUUID();
  const correlation = stringMap(extra.correlation);
  if (typeof extra.run_id === "string") correlation.run_id = extra.run_id;
  if (typeof extra.evaluation_id === "string") correlation.evaluation_id = extra.evaluation_id;
  if (typeof extra.child_session_id === "string") correlation.child_session_id = extra.child_session_id;
  correlation.request_id = requestId;
  if (hostId) correlation.host_id = hostId;
  return {
    requestId,
    idempotencyKey: (req.headers["idempotency-key"] as string) || extra.idempotency_key || "",
    hostRequestProof: extra.host_request_proof || "",
    approvedHostId: hostId,
    operatorId: "",
    operatorScopes: [],
    correlation,
  };
}

const tools = [
  { name: "get_capabilities", description: "Public Atlas contract and pcap_razorpay_test capability" },
  { name: "create_session", description: "Create shopping session and cart" },
  { name: "set_intent", description: "Set session intent and planning budget" },
  { name: "search_catalog", description: "Search sellable SKUs" },
  { name: "get_product", description: "Get product family plus eligible SKUs" },
  { name: "get_cart", description: "Get authoritative cart and offers" },
  { name: "add_cart_item", description: "Add SKU line" },
  { name: "update_cart_item", description: "Update line quantity" },
  { name: "remove_cart_item", description: "Remove cart line" },
  { name: "apply_offer", description: "Apply a shown offer onto the cart atomically" },
  { name: "prepare_checkout", description: "Atomic hold and CheckoutProposal" },
  { name: "complete_checkout", description: "Consume authority; pending order + payment hook" },
  { name: "get_order", description: "Poll merchant order and payment status" },
];

async function callTool(name: string, args: Record<string, unknown>, meta: any, md: grpc.Metadata) {
  const m = { meta };
  switch (name) {
    case "get_capabilities":
      return promisify(query, "GetCapabilities", { ...m, requestedContractVersion: args.requested_contract_version }, md);
    case "create_session":
      return promisify(sessions, "CreateSession", {
        ...m,
        subjectReference: args.subject_reference,
        deliveryServiceabilityReference: args.delivery_serviceability_reference,
        locale: args.locale,
        requestedLocationId: args.requested_location_id,
        evaluationArm: args.evaluation_arm,
        strategyAllowlist: Array.isArray(args.strategy_allowlist) ? args.strategy_allowlist : [],
      }, md);
    case "set_intent":
      return promisify(sessions, "SetIntent", {
        ...m,
        sessionId: args.session_id,
        expectedSessionContextVersion: args.expected_session_context_version,
        mission: args.mission,
        planningBudgetMinor: args.planning_budget_minor,
        currency: args.currency,
        constraints: stringMap(args.constraints),
      }, md);
    case "search_catalog":
      return promisify(query, "SearchCatalog", { ...m, sessionId: args.session_id, query: args.query, category: args.category, brand: args.brand, cursor: args.cursor, pageSize: args.page_size }, md);
    case "get_product":
      return promisify(query, "GetProduct", { ...m, sessionId: args.session_id, productId: args.product_id, locationId: args.location_id }, md);
    case "get_cart":
      return promisify(carts, "GetCart", { ...m, sessionId: args.session_id }, md);
    case "add_cart_item":
      return promisify(carts, "AddItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, skuId: args.sku_id, quantity: args.quantity }, md);
    case "update_cart_item":
      return promisify(carts, "UpdateItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, cartLineId: args.cart_line_id, quantity: args.quantity }, md);
    case "remove_cart_item":
      return promisify(carts, "RemoveItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, cartLineId: args.cart_line_id }, md);
    case "apply_offer":
      return promisify(carts, "ApplyOffer", { ...m, sessionId: args.session_id, offerId: args.offer_id, expectedSessionContextVersion: args.expected_session_context_version, expectedCartVersion: args.expected_cart_version }, md);
    case "prepare_checkout":
      return promisify(checkout, "PrepareCheckout", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedSessionContextVersion: args.expected_session_context_version, expectedCartVersion: args.expected_cart_version }, md);
    case "complete_checkout":
      return promisify(checkout, "CompleteCheckout", { ...m, sessionId: args.session_id, checkoutProposalId: args.checkout_proposal_id, checkoutAuthority: args.checkout_authority }, md);
    case "get_order":
      return promisify(checkout, "GetOrder", { ...m, sessionId: args.session_id, merchantOrderId: args.merchant_order_id }, md);
    default:
      throw Object.assign(new Error("unknown tool"), { code: "INVALID_ARGUMENT" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (req.method === "GET" && url.pathname === "/health/live") {
      return json(res, 200, { status: "live" });
    }
    if (req.method === "GET" && url.pathname === "/health/ready") {
      try {
        const coreReady = await fetch(`${coreHttpOrigin}/health/ready`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(1500),
        });
        const coreBody = await coreReady.json().catch(() => ({}));
        if (!coreReady.ok) {
          return json(res, 503, {
            status: "not_ready",
            components: [
              { name: "gateway", status: "READY", detail: "http listener up" },
              { name: "core", status: "NOT_READY", detail: `Core HTTP readiness returned ${coreReady.status}` },
            ],
          });
        }

        let health: any = { status: "ready", components: [] };
        const adminToken = process.env.ATLAS_TEST_ADMIN_BEARER || process.env.ATLAS_ADMIN_SERVICE_TOKEN || "";
        if (adminToken) {
          const md = new grpc.Metadata();
          md.set("authorization", `Bearer ${adminToken}`);
          try {
            health = await promisify(admin, "GetSystemHealth", { meta: { requestId: "ready" } }, md);
          } catch (err: any) {
            health = {
              status: "ready",
              components: [{
                name: "core_admin_health",
                status: "DEGRADED",
                detail: err?.code === grpc.status.UNAUTHENTICATED
                  ? "internal health credential rejected"
                  : "detailed Core health unavailable",
              }],
            };
          }
        }
        const components = Array.isArray(health?.components) ? health.components : [];
        const extras = await probeExternalHealth();
        const all = [
          { name: "core", status: "READY", detail: String(coreBody?.content_digest || "Core HTTP readiness passed") },
          ...components,
          ...extras,
        ];
        const requiredDown = all.some((c: { name?: string; status?: string }) =>
          ["postgresql", "migrations", "fixture", "core"].includes(String(c.name)) && c.status === "NOT_READY");
        return json(res, requiredDown ? 503 : 200, {
          status: requiredDown ? "not_ready" : health?.status || "ready",
          components: all,
        });
      } catch (err: any) {
        return json(res, 503, {
          status: "not_ready",
          components: [
            { name: "gateway", status: "READY", detail: "process up" },
            { name: "core", status: "NOT_READY", detail: err?.name === "TimeoutError" ? "Core HTTP readiness timed out" : "Core HTTP readiness unreachable" },
          ],
        });
      }
    }
    if (req.method === "POST" && url.pathname === "/providers/razorpay/webhooks") {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
      await handleRazorpayWebhook(req, res, secret, {
        ingestWebhook: async ({ rawBody, signature, eventId }) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          headers["x-razorpay-signature"] = signature;
          const out = await promisify(fabric, "IngestProviderWebhook", {
            rawBody,
            headers,
            eventId,
          }, fabricMeta("webhook"));
          if (out?.code === "PROVIDER_EVENT_DUPLICATE") return { duplicate: true };
          if (out && out.accepted === false && out.code && out.code !== "") {
            throw new Error(out.code);
          }
        },
      });
      return;
    }
    if ((process.env.ATLAS_ENVIRONMENT ?? "test") === "test" && url.pathname.startsWith("/internal/v1/test-runner/")) {
      const cred = process.env.ATLAS_RUNNER_EXECUTOR_CREDENTIAL ?? "";
      await handleRunnerRequest(req, res, cred, {
        claimJob: async () => {
          const out = await promisify(fabric, "ClaimRunnerJob", { executorCredential: cred }, fabricMeta("runner"));
          if (!out?.jobId) return null;
          const payload = out.checkoutPayloadJson ? JSON.parse(out.checkoutPayloadJson) : {};
          return {
            job_id: out.jobId,
            payment_attempt_id: out.paymentAttemptId || payload.payment_attempt_id,
            executor_token: payload.executor_token,
            razorpay_order_id: out.razorpayOrderId || payload.razorpay_order_id,
            razorpay_key_id: payload.razorpay_key_id,
            amount_minor: payload.amount_minor,
            currency: payload.currency,
            scenario: payload.scenario,
            checkout_page_url: payload.checkout_page_url,
            callback_origin: payload.callback_origin,
          };
        },
        recordObservation: async (jobId, observation) => {
          await promisify(fabric, "ReportRunnerObservation", {
            jobId,
            executorCredential: cred,
            observationJson: JSON.stringify(observation),
          }, fabricMeta("runner"));
        },
      });
      return;
    }
    if (url.pathname.startsWith("/test/v1/fixtures")) {
      const token = bearer(req);
      const expectedFixture = process.env.ATLAS_TEST_FIXTURE_BEARER;
      if (!token || (expectedFixture && token !== expectedFixture)) {
        return json(res, 401, { code: "UNAUTHENTICATED" });
      }
      const meta = { requestId: req.headers["x-request-id"] || crypto.randomUUID(), operatorId: "fixture-control" };
      if (req.method === "POST" && url.pathname === "/test/v1/fixtures/reset") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = await promisify(fixtures, "ResetFixtures", { meta, fixtureSnapshotId: body.fixture_snapshot_id || "fix_quickmart_v1" }, grpcMeta(req));
        return json(res, 200, out);
      }
      if (req.method === "GET" && url.pathname === "/test/v1/fixtures/current") {
        const out = await promisify(fixtures, "CurrentFixture", {}, grpcMeta(req));
        return json(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/test/v1/fixtures/payment-outcome") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const coreRes = await fetch(`${coreHttpOrigin}/internal/v1/fixtures/payment-outcome`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_id: body.session_id, outcome: body.outcome, evaluation_id: body.evaluation_id || "", reason: body.reason || "" }),
        });
        if (!coreRes.ok) return json(res, coreRes.status, await coreRes.json().catch(() => ({ code: "FAILED" })));
        return json(res, 200, await coreRes.json());
      }
      if (req.method === "POST" && url.pathname === "/test/v1/fixtures/invalidate-inventory") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const coreRes = await fetch(`${coreHttpOrigin}/internal/v1/fixtures/invalidate-inventory`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            location_id: body.location_id,
            sku_id: body.sku_id,
            evaluation_id: body.evaluation_id || "",
            reason: body.reason || "atlaslab_inventory_invalidate",
          }),
        });
        if (coreRes.status === 404) return json(res, 404, { code: "HOOK_UNAVAILABLE" });
        if (!coreRes.ok) return json(res, coreRes.status, await coreRes.json().catch(() => ({ code: "FAILED" })));
        return json(res, 200, await coreRes.json());
      }
    }
    if (req.method === "GET" && url.pathname === "/eval/v1/evidence") {
      const token = bearer(req);
      if (!token) return json(res, 401, { code: "UNAUTHENTICATED" });
      const sessionId = url.searchParams.get("session_id") || "";
      const coreRes = await fetch(`${coreHttpOrigin}/internal/v1/eval/evidence?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!coreRes.ok) return json(res, coreRes.status, await coreRes.json().catch(() => ({ code: "NOT_FOUND" })));
      return json(res, 200, await coreRes.json());
    }
    if (url.pathname.startsWith("/admin/v1/")) {
      return await handleAdmin(req, res, url);
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      if (body.method === "initialize") {
        return json(res, 200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "atlas.merchant.v1", version: "1" } } });
      }
      if (body.method === "notifications/initialized" || body.method === "ping") {
        return json(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result: {} });
      }
      if (body.method === "tools/list") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: tools.filter((t) => PUBLIC_TOOLS.has(t.name)).map((t) => ({ ...t, inputSchema: publicInputSchema(t.name) })),
          },
        });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name as string;
        if (!PUBLIC_TOOLS.has(name) || name === "get_session" || name === "get_profile" || name === "get_substitution" || name === "respond_to_substitution" || name === "accept_offer") {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "tool is not on public MCP" } });
        }
        const args = body.params?.arguments ?? {};
        const extra = body.params?._meta?.["com.atlas/request"] ?? {};
        let hostId = "";
        if (name !== "get_capabilities") {
          const token = bearer(req);
          if (!token) return json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "HOST_UNAUTHENTICATED" } });
          try {
            hostId = await authenticateHost(token);
          } catch {
            return json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "HOST_UNAUTHENTICATED" } });
          }
        }
        const checked = validateToolArguments(name, args);
        if (!checked.ok) {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: checked.message, data: { code: "INVALID_ARGUMENT" } } });
        }
        if (MUTATIONS.has(name) && !extra.host_request_proof) {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "HOST_FORBIDDEN" } });
        }
        try {
          const result = await callTool(name, args, atlasMeta(req, extra, hostId), grpcMeta(req));
          const envelope = mcpOk(result, body.id);
          return json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope } });
        } catch (err: any) {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: mcpRpcError(err) });
        }
      }
      return json(res, 400, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }
    json(res, 404, { code: "NOT_FOUND" });
  } catch (err: any) {
    if (err?.code === "PAYLOAD_TOO_LARGE") {
      return json(res, 413, { code: "PAYLOAD_TOO_LARGE" });
    }
    json(res, 500, { code: err?.code === "HOST_UNAUTHENTICATED" ? "HOST_UNAUTHENTICATED" : "TEMPORARILY_UNAVAILABLE", request_id: req.headers["x-request-id"] || "" });
  }
});

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const serviceToken = (req.headers["x-atlas-service-token"] as string) || "";
  const expectedService = process.env.ATLAS_ADMIN_SERVICE_TOKEN;
  const token = bearer(req);
  if (expectedService && serviceToken && serviceToken !== expectedService) {
    return json(res, 401, { code: "UNAUTHENTICATED" }, String(req.headers["x-request-id"] || ""));
  }
  if (!token) return json(res, 401, { code: "UNAUTHENTICATED" }, String(req.headers["x-request-id"] || ""));
  let operator;
  try {
    operator = await authenticateOperator(token);
  } catch {
    return json(res, 401, { code: "UNAUTHENTICATED" }, String(req.headers["x-request-id"] || ""));
  }
  const meta = atlasMeta(req, {}, "");
  meta.operatorId = operator.operatorId;
  meta.operatorScopes = operator.operatorScopes;
  const md = grpcMeta(req);
  const p = url.pathname;
  const ok = async (method: string, client: any, reqBody: unknown) =>
    json(res, 200, mcpOk(await promisify(client, method, reqBody, md), meta.requestId));
  try {
    if (req.method === "GET" && p === "/admin/v1/merchant/profile") return await ok("GetMerchantProfile", admin, { meta });
    if (req.method === "PUT" && p === "/admin/v1/merchant/profile") {
      const body = parseAdminBody((await readBody(req)).toString() || "{}", ["expected_version", "display_name", "description", "support_email"]);
      return await ok("UpdateMerchantProfile", admin, {
        meta,
        expectedVersion: body.expected_version,
        displayName: body.display_name,
        description: body.description,
        supportEmail: body.support_email,
      });
    }
    if (req.method === "GET" && p === "/admin/v1/merchant/locations") return await ok("ListLocations", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/merchant/products") {
      return await ok("ListProducts", admin, { meta, pageSize: 200 });
    }
    const productMatch = p.match(/^\/admin\/v1\/merchant\/products\/([^/]+)$/);
    if (req.method === "GET" && productMatch) {
      return await ok("GetProductAdmin", admin, { meta, productId: decodeURIComponent(productMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/merchant/inventory") {
      return await ok("ListInventory", admin, { meta, locationId: url.searchParams.get("location_id") || "" });
    }
    if (req.method === "POST" && p === "/admin/v1/merchant/inventory/adjustments") {
      const body = parseAdminBody((await readBody(req)).toString() || "{}", ["location_id", "sku_id", "on_hand_delta", "delta", "reason"]);
      return await ok("AdjustInventory", admin, {
        meta,
        locationId: body.location_id,
        skuId: body.sku_id,
        onHandDelta: body.on_hand_delta ?? body.delta,
        reason: body.reason || "",
      });
    }
    if (req.method === "GET" && p === "/admin/v1/merchant/relationships") return await ok("ListRelationships", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/merchant/promotions") return await ok("ListPromotions", admin, { meta });
    const promoMatch = p.match(/^\/admin\/v1\/merchant\/promotions\/([^/]+)$/);
    if (req.method === "PUT" && promoMatch) {
      const body = parseAdminBody((await readBody(req)).toString() || "{}", ["expected_version", "enabled"]);
      return await ok("UpdatePromotion", admin, {
        meta,
        promotionId: decodeURIComponent(promoMatch[1]),
        expectedVersion: body.expected_version ?? 0,
        enabled: body.enabled,
      });
    }
    if (req.method === "GET" && p === "/admin/v1/merchant/strategies") return await ok("ListStrategies", admin, { meta });
    if (req.method === "PUT" && p === "/admin/v1/merchant/strategies") {
      const body = parseAdminBody((await readBody(req)).toString() || "{}", ["strategies"]);
      const rows = Array.isArray(body.strategies) ? body.strategies : [];
      return await ok("UpdateStrategies", admin, {
        meta,
        strategies: rows.map((row: Record<string, unknown>) => ({
          strategyType: row.strategy_type ?? row.strategy,
          enabled: row.enabled,
          revision: row.revision,
          expectedRevision: row.expected_revision ?? row.revision,
          visibility: row.visibility,
          surfaces: Array.isArray(row.surfaces) ? row.surfaces : [],
        })),
      });
    }
    if (req.method === "POST" && p === "/admin/v1/merchant/rules/preview") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      return await ok("PreviewRules", admin, { meta, fixtureCartName: body.fixture_cart_name || "" });
    }
    if (req.method === "GET" && p === "/admin/v1/commerce/sessions") {
      return await ok("ListSessions", admin, { meta, pageSize: 100 });
    }
    const sessionMatch = p.match(/^\/admin\/v1\/commerce\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      return await ok("GetSessionAdmin", admin, { meta, sessionId: decodeURIComponent(sessionMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/commerce/offers") {
      return await ok("ListOffers", admin, { meta, sessionId: url.searchParams.get("session_id") || "" });
    }
    const offerMatch = p.match(/^\/admin\/v1\/commerce\/offers\/([^/]+)$/);
    if (req.method === "GET" && offerMatch) {
      return await ok("GetOffer", admin, { meta, offerId: decodeURIComponent(offerMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/commerce/orders") {
      return await ok("ListOrders", admin, { meta, pageSize: 100 });
    }
    const orderMatch = p.match(/^\/admin\/v1\/commerce\/orders\/([^/]+)$/);
    if (req.method === "GET" && orderMatch) {
      return await ok("GetOrderAdmin", admin, { meta, merchantOrderId: decodeURIComponent(orderMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/trust/attention") return await ok("GetAttention", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/merchant/outcomes") return await ok("GetMerchantOutcomes", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/trust/hosts") return await ok("ListHosts", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/search") {
      return await ok("SearchResources", admin, { meta, query: url.searchParams.get("q") || "" });
    }
    if (req.method === "GET" && p === "/admin/v1/audit/events") {
      const auditReq: Record<string, unknown> = { meta, pageSize: 50 };
      if (url.searchParams.get("needs_attention") === "true") auditReq.needsAttention = true;
      if (url.searchParams.get("resource_id")) auditReq.resourceId = url.searchParams.get("resource_id");
      if (url.searchParams.get("resource_type")) auditReq.resourceType = url.searchParams.get("resource_type");
      return await ok("ListAuditEvents", audit, auditReq);
    }
    const auditMatch = p.match(/^\/admin\/v1\/audit\/events\/([^/]+)$/);
    if (req.method === "GET" && auditMatch) {
      return await ok("GetAuditEvent", audit, { meta, auditEventId: decodeURIComponent(auditMatch[1]) });
    }
    if (req.method === "POST" && p === "/admin/v1/audit/exports") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      return json(
        res,
        200,
        mcpOk(
          await promisify(audit, "CreateAuditExport", {
            meta,
            format: body.format,
            filterJson: JSON.stringify(body.filters || {}),
          }, md),
          meta.requestId,
        ),
      );
    }
    if (req.method === "GET" && p === "/admin/v1/operations") return await ok("ListOperations", admin, { meta });
    const reconcileMatch = p.match(/^\/admin\/v1\/operations\/([^/]+)\/reconcile$/);
    if (req.method === "POST" && reconcileMatch) {
      return await ok("ReconcileOperation", admin, { meta, operationId: decodeURIComponent(reconcileMatch[1]) });
    }
    const operationMatch = p.match(/^\/admin\/v1\/operations\/([^/]+)$/);
    if (req.method === "GET" && operationMatch) {
      return await ok("GetOperationTimeline", audit, { meta, operationId: decodeURIComponent(operationMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/system/capabilities") return await ok("GetSystemCapabilities", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/system/health") return await ok("GetSystemHealth", admin, { meta });
    if (req.method === "GET" && p === "/admin/v1/system/outcomes") return await ok("GetMerchantOutcomes", admin, { meta });
    json(res, 404, { code: "NOT_FOUND", request_id: meta.requestId });
  } catch (err: any) {
    if (err?.code === "INVALID_ARGUMENT" || err?.code === "PAYLOAD_TOO_LARGE") {
      return json(res, err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { code: err.code }, meta.requestId);
    }
    json(res, 502, publicAdminError(err, meta.requestId));
  }
}

server.listen(Number(listen.split(":")[1] ?? 8080), listen.split(":")[0], () => {
  console.log(JSON.stringify({ msg: "gateway listening", addr: listen }));
});

async function probeExternalHealth(): Promise<Array<{ name: string; status: string; detail: string }>> {
  const checks: Array<{ name: string; env: string }> = [
    { name: "worker", env: "ATLAS_WORKER_HEALTH_URL" },
    { name: "payment_runner", env: "ATLAS_PAYMENT_RUNNER_HEALTH_URL" },
    { name: "atlaslab", env: "ATLASLAB_URL" },
  ];
  const out: Array<{ name: string; status: string; detail: string }> = [
    { name: "gateway", status: "READY", detail: "http listener up" },
    {
      name: "openrouter",
      status: process.env.OPENROUTER_API_KEY ? "CONFIGURED" : "UNCONFIGURED",
      detail: "AtlasLab model dependency; not required for Core readiness",
    },
  ];
  for (const c of checks) {
    const url = process.env[c.env];
    if (!url) {
      out.push({ name: c.name, status: "UNKNOWN", detail: `${c.env} unset` });
      continue;
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health/ready`, { signal: AbortSignal.timeout(1500) });
      out.push({ name: c.name, status: res.ok ? "READY" : "NOT_READY", detail: `http ${res.status}` });
    } catch {
      out.push({ name: c.name, status: "NOT_READY", detail: "health probe failed" });
    }
  }
  return out;
}

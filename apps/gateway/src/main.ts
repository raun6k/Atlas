import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { handleRazorpayWebhook } from "./webhooks/razorpay/http.js";
import { handleRunnerRequest } from "./internal/test-runner/http.js";
import { mcpOk } from "./mcp-map.js";

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
const fulfill = new pkg.atlas.merchant.v1.FulfillmentService(coreAddr, grpc.credentials.createInsecure());
const admin = new pkg.atlas.merchant.v1.AdminService(coreAddr, grpc.credentials.createInsecure());
const audit = new pkg.atlas.merchant.v1.AuditService(coreAddr, grpc.credentials.createInsecure());
const fixtures = new pkg.atlas.merchant.v1.FixtureService(coreAddr, grpc.credentials.createInsecure());
const fabric = new pkg.atlas.merchant.v1.PaymentFabricService(coreAddr, grpc.credentials.createInsecure());
const coreHttp = process.env.ATLAS_CORE_HTTP_ADDR ?? "http://127.0.0.1:9091";
const coreHttpOrigin = coreHttp.includes("://") ? coreHttp : `http://${coreHttp}`;

const PUBLIC_TOOLS = new Set([
  "get_capabilities", "create_session", "set_intent", "search_catalog", "get_product",
  "get_cart", "add_cart_item", "update_cart_item", "remove_cart_item",
  "accept_offer", "apply_offer", "prepare_checkout", "complete_checkout",
  "get_order", "respond_to_substitution",
]);

const MUTATIONS = new Set([
  "create_session", "set_intent", "add_cart_item", "update_cart_item", "remove_cart_item",
  "accept_offer", "apply_offer", "prepare_checkout", "complete_checkout", "respond_to_substitution",
]);

function promisify(client: any, method: string, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](req, (err: grpc.ServiceError, res: unknown) => (err ? reject(err) : resolve(res)));
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
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

function atlasMeta(req: IncomingMessage, extra: Record<string, unknown>, hostId = ""): any {
  const requestId = (req.headers["x-request-id"] as string) || (extra.request_id as string) || crypto.randomUUID();
  return {
    requestId,
    idempotencyKey: (req.headers["idempotency-key"] as string) || extra.idempotency_key || "",
    hostRequestProof: extra.host_request_proof || "",
    approvedHostId: hostId,
    operatorId: extra.operator_id || "",
    operatorScopes: extra.operator_scopes || [],
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
  { name: "accept_offer", description: "Record offer acceptance signal" },
  { name: "apply_offer", description: "Atomically apply stored offer patch" },
  { name: "prepare_checkout", description: "Atomic hold and CheckoutProposal" },
  { name: "complete_checkout", description: "Consume authority; pending order + payment hook" },
  { name: "get_order", description: "Poll merchant order and substitutions" },
  { name: "respond_to_substitution", description: "Respond to a substitution request" },
];

async function callTool(name: string, args: Record<string, unknown>, meta: any) {
  const m = { meta };
  switch (name) {
    case "get_capabilities":
      return promisify(query, "GetCapabilities", { ...m, requestedContractVersion: args.requested_contract_version });
    case "create_session":
      return promisify(sessions, "CreateSession", { ...m, subjectReference: args.subject_reference, deliveryServiceabilityReference: args.delivery_serviceability_reference, locale: args.locale, requestedLocationId: args.requested_location_id, evaluationArm: args.evaluation_arm });
    case "set_intent":
      return promisify(sessions, "SetIntent", { ...m, sessionId: args.session_id, expectedSessionContextVersion: args.expected_session_context_version, mission: args.mission, planningBudgetMinor: args.planning_budget_minor, currency: args.currency });
    case "search_catalog":
      return promisify(query, "SearchCatalog", { ...m, sessionId: args.session_id, query: args.query, category: args.category, brand: args.brand, cursor: args.cursor, pageSize: args.page_size });
    case "get_product":
      return promisify(query, "GetProduct", { ...m, sessionId: args.session_id, productId: args.product_id, locationId: args.location_id });
    case "get_cart":
      return promisify(carts, "GetCart", { ...m, sessionId: args.session_id });
    case "add_cart_item":
      return promisify(carts, "AddItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, skuId: args.sku_id, quantity: args.quantity });
    case "update_cart_item":
      return promisify(carts, "UpdateItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, cartLineId: args.cart_line_id, quantity: args.quantity });
    case "remove_cart_item":
      return promisify(carts, "RemoveItem", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedCartVersion: args.expected_cart_version, cartLineId: args.cart_line_id });
    case "accept_offer":
      return promisify(carts, "AcceptOffer", { ...m, sessionId: args.session_id, offerId: args.offer_id, expectedSessionContextVersion: args.expected_session_context_version, expectedCartVersion: args.expected_cart_version });
    case "apply_offer":
      return promisify(carts, "ApplyOffer", { ...m, sessionId: args.session_id, offerId: args.offer_id, expectedSessionContextVersion: args.expected_session_context_version, expectedCartVersion: args.expected_cart_version });
    case "prepare_checkout":
      return promisify(checkout, "PrepareCheckout", { ...m, sessionId: args.session_id, cartId: args.cart_id, expectedSessionContextVersion: args.expected_session_context_version, expectedCartVersion: args.expected_cart_version });
    case "complete_checkout":
      return promisify(checkout, "CompleteCheckout", { ...m, sessionId: args.session_id, checkoutProposalId: args.checkout_proposal_id, checkoutAuthority: args.checkout_authority });
    case "get_order":
      return promisify(checkout, "GetOrder", { ...m, sessionId: args.session_id, merchantOrderId: args.merchant_order_id });
    case "respond_to_substitution":
      return promisify(fulfill, "RespondToSubstitution", { ...m, sessionId: args.session_id, merchantOrderId: args.merchant_order_id, substitutionRequestId: args.substitution_request_id, expectedSubstitutionVersion: args.expected_substitution_version, selectedOptionId: args.selected_option_id, decline: args.decline });
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
        await promisify(query, "GetCapabilities", { meta: { requestId: "ready" } });
        return json(res, 200, { status: "ready" });
      } catch {
        return json(res, 503, { status: "not_ready" });
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
          });
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
          const out = await promisify(fabric, "ClaimRunnerJob", { executorCredential: cred });
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
          });
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
        const out = await promisify(fixtures, "ResetFixtures", { meta, fixtureSnapshotId: body.fixture_snapshot_id || "fix_quickmart_v1" });
        return json(res, 200, out);
      }
      if (req.method === "GET" && url.pathname === "/test/v1/fixtures/current") {
        const out = await promisify(fixtures, "CurrentFixture", {});
        return json(res, 200, out);
      }
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
        return json(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: tools.filter((t) => PUBLIC_TOOLS.has(t.name)).map((t) => ({ ...t, inputSchema: { type: "object" } })) } });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name as string;
        if (!PUBLIC_TOOLS.has(name) || name === "get_session" || name === "get_profile" || name === "get_substitution") {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "tool is not on public MCP" } });
        }
        const args = body.params?.arguments ?? {};
        const extra = body.params?._meta?.["com.atlas/request"] ?? {};
        let hostId = "";
        if (name !== "get_capabilities") {
          const token = bearer(req);
          if (!token) return json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "HOST_UNAUTHENTICATED" } });
          hostId = await authenticateHost(token);
        }
        if (MUTATIONS.has(name) && !extra.host_request_proof) {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "HOST_FORBIDDEN" } });
        }
        try {
          const result = await callTool(name, args, atlasMeta(req, extra, hostId));
          const envelope = mcpOk(result, body.id);
          return json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope } });
        } catch (err: any) {
          return json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: err.details || err.message } });
        }
      }
      return json(res, 400, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }
    json(res, 404, { code: "NOT_FOUND" });
  } catch (err: any) {
    json(res, 500, { code: "TEMPORARILY_UNAVAILABLE", message: err.message });
  }
});

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const serviceToken = (req.headers["x-atlas-service-token"] as string) || "";
  const expectedService = process.env.ATLAS_ADMIN_SERVICE_TOKEN;
  const token = bearer(req);
  if (expectedService && serviceToken && serviceToken !== expectedService) {
    return json(res, 401, { code: "UNAUTHENTICATED" });
  }
  if (!token && !serviceToken) return json(res, 401, { code: "UNAUTHENTICATED" });
  const meta = atlasMeta(req, { operator_id: "op_merchant_quickmart", operator_scopes: ["merchant:read", "merchant:manage", "audit:read", "audit:export", "refund:manage"] }, "");
  meta.operatorId = "op_merchant_quickmart";
  meta.operatorScopes = ["merchant:read", "merchant:manage", "audit:read", "audit:export", "refund:manage"];
  const p = url.pathname;
  const ok = async (method: string, client: any, reqBody: unknown) =>
    json(res, 200, mcpOk(await promisify(client, method, reqBody), meta.requestId));
  try {
    if (req.method === "GET" && p === "/admin/v1/merchant/profile") return await ok("GetMerchantProfile", admin, { meta });
    if (req.method === "PUT" && p === "/admin/v1/merchant/profile") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
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
      const body = JSON.parse((await readBody(req)).toString() || "{}");
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
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      return await ok("UpdatePromotion", admin, {
        meta,
        promotionId: decodeURIComponent(promoMatch[1]),
        expectedVersion: body.expected_version ?? 0,
        enabled: body.enabled,
      });
    }
    if (req.method === "GET" && p === "/admin/v1/merchant/strategies") return await ok("ListStrategies", admin, { meta });
    if (req.method === "PUT" && p === "/admin/v1/merchant/strategies") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const rows = Array.isArray(body.strategies) ? body.strategies : [];
      return await ok("UpdateStrategies", admin, {
        meta,
        strategies: rows.map((row: Record<string, unknown>) => ({
          strategyType: row.strategy_type ?? row.strategy,
          enabled: row.enabled,
          revision: row.revision,
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
    const refundMatch = p.match(/^\/admin\/v1\/commerce\/orders\/([^/]+)\/refunds$/);
    if (req.method === "POST" && refundMatch) {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const out = await promisify(admin, "CreateRefund", {
        meta,
        merchantOrderId: decodeURIComponent(refundMatch[1]),
        amountMinor: body.amount_minor ?? body.amountMinor,
        currency: body.currency || "INR",
        reason: body.reason || body.reason_code || "",
      });
      return json(res, 200, mcpOk(out, meta.requestId));
    }
    const orderMatch = p.match(/^\/admin\/v1\/commerce\/orders\/([^/]+)$/);
    if (req.method === "GET" && orderMatch) {
      return await ok("GetOrderAdmin", admin, { meta, merchantOrderId: decodeURIComponent(orderMatch[1]) });
    }
    if (req.method === "GET" && p === "/admin/v1/trust/attention") return await ok("GetAttention", admin, { meta });
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
          }),
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
    json(res, 404, { code: "NOT_FOUND" });
  } catch (err: any) {
    json(res, 502, { code: err?.code === 12 ? "UNIMPLEMENTED" : "UPSTREAM", message: err?.details || err?.message || "admin upstream failed" });
  }
}

server.listen(Number(listen.split(":")[1] ?? 8080), listen.split(":")[0], () => {
  console.log(JSON.stringify({ msg: "gateway listening", addr: listen }));
});

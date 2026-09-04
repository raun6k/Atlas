import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LabError } from "../types.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { LabStore } from "../db/store.js";
import { buildReport } from "../reporter/reporter.js";
import { utcNow } from "../ids.js";
import type { ArtifactRecord } from "../types.js";
import { envelope, analyticsOverview, analyticsSellability, analyticsFailures, analyticsIssues, analyticsExperiments } from "../evaluator/analytics.js";
import { getOrComputeProof } from "../evaluator/proof.js";

function presentReport(art: ArtifactRecord | undefined, kind: string, title: string) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(art?.body ?? "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    report_id: art?.report_id ?? `rpt_${kind.toLowerCase()}`,
    kind,
    title,
    caveat:
      typeof parsed.forbidden_claim === "string"
        ? `Does not support ${parsed.forbidden_claim}`
        : String(parsed.evidence_label ?? parsed.note ?? "Razorpay Test Mode — Simulated"),
    numerator: parsed.numerator,
    denominator: parsed.denominator,
    model_configuration: "OpenRouter",
    time_window: "all recorded runs",
    stages: parsed.stages ?? [],
  };
}

export interface HttpContext {
  orchestrator: Orchestrator;
  store: LabStore;
  apiToken: string;
  live: () => boolean;
  ready: () => Promise<{ ready: boolean; details: Record<string, unknown> }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-request-id", requestId);
  res.end(JSON.stringify(body));
}

function authorize(req: IncomingMessage, token: string, mutating: boolean): "ok" | "unauthorized" | "forbidden" {
  const header = req.headers.authorization ?? "";
  if (!token) {
    return header ? "ok" : mutating ? "unauthorized" : "ok";
  }
  if (!header) return "unauthorized";
  if (header !== `Bearer ${token}`) return "forbidden";
  return "ok";
}

export function createLabServer(ctx: HttpContext): Server {
  return createServer((req, res) => {
    void handle(req, res, ctx);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const requestId = String(req.headers["x-request-id"] ?? `req_${Date.now()}`);
  const url = new URL(req.url ?? "/", "http://atlaslab.local");
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (path === "/health/live" && method === "GET") {
      send(res, 200, { status: "live" }, requestId);
      return;
    }
    if (path === "/health/ready" && method === "GET") {
      const ready = await ctx.ready();
      send(res, ready.ready ? 200 : 503, { status: ready.ready ? "ready" : "not_ready", ...ready.details }, requestId);
      return;
    }

    const mutating = method !== "GET" && method !== "HEAD";
    const auth = authorize(req, ctx.apiToken, mutating);
    if (auth === "unauthorized") {
      send(res, 401, { error: { code: "UNAUTHORIZED", message: "missing bearer", request_id: requestId } }, requestId);
      return;
    }
    if (auth === "forbidden") {
      send(res, 403, { error: { code: "FORBIDDEN", message: "invalid lab credential", request_id: requestId } }, requestId);
      return;
    }

    if (path === "/lab/v1/capabilities" && method === "GET") {
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), ...ctx.orchestrator.capabilities() }, requestId);
      return;
    }
    if (path === "/lab/v1/scenarios" && method === "GET") {
      const scenarios = ctx.orchestrator.listScenarios();
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), scenarios, items: scenarios }, requestId);
      return;
    }
    const oneScenario = path.match(/^\/lab\/v1\/scenarios\/([^/]+)$/);
    if (oneScenario && method === "GET") {
      const scenario = ctx.orchestrator.listScenarios().find((s) => s.scenario_id === oneScenario[1]);
      if (!scenario) throw new LabError("NOT_FOUND", "scenario not found", 404);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), ...scenario }, requestId);
      return;
    }
    if (path === "/lab/v1/runs" && method === "GET") {
      const runs = await ctx.store.listRuns();
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), runs, items: runs }, requestId);
      return;
    }
    if (path === "/lab/v1/pairs" && method === "GET") {
      const pairs = await ctx.store.listPairs();
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), pairs, items: pairs }, requestId);
      return;
    }
    if (path === "/lab/v1/reports" && method === "GET") {
      const runs = await ctx.store.listRuns();
      const pairs = await ctx.store.listPairs();
      const sell = await buildReport(ctx.store, { kind: "sellability", runs });
      const contract = await buildReport(ctx.store, { kind: "contract", runs });
      const incrementality = pairs[0]
        ? await buildReport(ctx.store, { kind: "incrementality", runs, pair: pairs[0] })
        : [];
      const items = [
        presentReport(sell[0], "SELLABILITY", "Agent Sellability"),
        presentReport(contract[0], "CONTRACT", "Deterministic contract suite"),
        ...(incrementality[0] ? [presentReport(incrementality[0], "INCREMENTALITY", "Commercial incrementality")] : []),
      ];
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), items }, requestId);
      return;
    }
    if (path === "/lab/v1/configurations" && method === "GET") {
      send(res, 200, { request_id: requestId, configurations: await ctx.store.listConfigurations() }, requestId);
      return;
    }
    if (path === "/lab/v1/runs" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      if (body.buyer_request && !body.custom_user_input) {
        body.custom_user_input = body.buyer_request;
      }
      const run = await ctx.orchestrator.startRun(body);
      send(res, 201, { request_id: requestId, occurred_at: utcNow(), run, ...run }, requestId);
      return;
    }
    const cancel = path.match(/^\/lab\/v1\/runs\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") {
      const run = await ctx.orchestrator.cancel(cancel[1]!);
      send(res, 200, { request_id: requestId, run }, requestId);
      return;
    }
    const events = path.match(/^\/lab\/v1\/runs\/([^/]+)\/events$/);
    if (events && method === "GET") {
      const cursor = Number(url.searchParams.get("after") ?? "0");
      const list = await ctx.store.listEvents(events[1]!, cursor);
      send(
        res,
        200,
        { request_id: requestId, events: list, items: list, next_cursor: list.at(-1)?.record_sequence ?? cursor },
        requestId,
      );
      return;
    }
    const evals = path.match(/^\/lab\/v1\/runs\/([^/]+)\/evaluations$/);
    if (evals && method === "GET") {
      send(
        res,
        200,
        {
          request_id: requestId,
          evaluations: await ctx.store.listEvaluations(evals[1]!),
          grades: await ctx.store.listGrades(evals[1]!),
        },
        requestId,
      );
      return;
    }
    const proof = path.match(/^\/lab\/v1\/runs\/([^/]+)\/proof$/);
    if (proof && method === "GET") {
      const run = await ctx.store.getRun(proof[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const scn = ctx.orchestrator.scenarios.find((s) => s.scenario_id === run.scenario_id);
      const got = await getOrComputeProof(ctx.store, run, scn, ctx.orchestrator.extraSecrets());
      send(res, 200, envelope(requestId, got.proof), requestId);
      return;
    }
    const traj = path.match(/^\/lab\/v1\/runs\/([^/]+)\/trajectory$/);
    if (traj && method === "GET") {
      const run = await ctx.store.getRun(traj[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const scn = ctx.orchestrator.scenarios.find((s) => s.scenario_id === run.scenario_id);
      const got = await getOrComputeProof(ctx.store, run, scn, ctx.orchestrator.extraSecrets());
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), steps: got.trajectory }, requestId);
      return;
    }
    const pay = path.match(/^\/lab\/v1\/runs\/([^/]+)\/payment-assurance$/);
    if (pay && method === "GET") {
      const run = await ctx.store.getRun(pay[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const scn = ctx.orchestrator.scenarios.find((s) => s.scenario_id === run.scenario_id);
      const got = await getOrComputeProof(ctx.store, run, scn, ctx.orchestrator.extraSecrets());
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), ...got.assurance }, requestId);
      return;
    }
    if (path === "/lab/v1/analytics/overview" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsOverview(ctx.store, ctx.orchestrator)), requestId);
      return;
    }
    if (path === "/lab/v1/analytics/sellability" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsSellability(ctx.store, ctx.orchestrator)), requestId);
      return;
    }
    if (path === "/lab/v1/analytics/failures" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsFailures(ctx.store, ctx.orchestrator)), requestId);
      return;
    }
    if (path === "/lab/v1/analytics/issues" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsIssues(ctx.store, ctx.orchestrator)), requestId);
      return;
    }
    if (path === "/lab/v1/analytics/experiments" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsExperiments(ctx.store)), requestId);
      return;
    }
    const oneRun = path.match(/^\/lab\/v1\/runs\/([^/]+)$/);
    if (oneRun && method === "GET") {
      const run = await ctx.store.getRun(oneRun[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), run, ...run }, requestId);
      return;
    }
    if (path === "/lab/v1/pairs" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      const pair = await ctx.orchestrator.startPair(body);
      send(res, 201, { request_id: requestId, pair }, requestId);
      return;
    }
    const onePair = path.match(/^\/lab\/v1\/pairs\/([^/]+)$/);
    if (onePair && method === "GET") {
      const pair = await ctx.store.getPair(onePair[1]!);
      if (!pair) throw new LabError("NOT_FOUND", "pair not found", 404);
      send(res, 200, { request_id: requestId, pair }, requestId);
      return;
    }
    const report = path.match(/^\/lab\/v1\/reports\/([^/]+)$/);
    if (report && method === "GET") {
      let arts = await ctx.store.getArtifactsByReport(report[1]!);
      if (arts.length === 0) {
        const runs = await ctx.store.listRuns();
        arts = await buildReport(ctx.store, { kind: "sellability", runs });
      }
      send(res, 200, { request_id: requestId, report_id: arts[0]?.report_id, artifacts: arts, razorpay_test_mode: true }, requestId);
      return;
    }
    send(res, 404, { error: { code: "NOT_FOUND", message: "unknown route", request_id: requestId } }, requestId);
  } catch (err) {
    if (err instanceof LabError) {
      send(res, err.status, { error: { code: err.code, message: err.message, request_id: requestId, details: err.details } }, requestId);
      return;
    }
    send(res, 500, { error: { code: "INTERNAL", message: "internal error", request_id: requestId } }, requestId);
  }
}

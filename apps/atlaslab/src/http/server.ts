import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorizeLab } from "../auth.js";
import type { AtlasLabConfig } from "../config.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { LabStore } from "../db/store.js";
import { utcNow } from "../ids.js";
import { envelope, analyticsOverview, analyticsSellability, analyticsFailures, analyticsIssues, analyticsExperiments, analyticsMerchantOutcomes } from "../evaluator/analytics.js";
import { getOrComputeProof } from "../evaluator/proof.js";
import { loadSuiteReport } from "../deterministic/suite.js";
import { loadCompatibilityReport, loadCommercialReport } from "../model-eval/suite.js";
import { COMPAT_SCENARIO_ID, COMMERCIAL_SCENARIO_ID } from "../model-eval/missions.js";
import { LabError } from "../types.js";

export interface HttpContext {
  orchestrator: Orchestrator;
  store: LabStore;
  cfg: AtlasLabConfig;
  live: () => boolean;
  ready: () => Promise<{ ready: boolean; details: Record<string, unknown> }>;
  liveEvalReady: () => Promise<{ ready: boolean; details: Record<string, unknown> }>;
}

const MAX_BODY_BYTES = 1_048_576;

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new LabError("PAYLOAD_TOO_LARGE", `request body exceeds ${limit} bytes`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const body = JSON.parse(raw || "{}") as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new LabError("INVALID_ARGUMENT", "request body must be a JSON object", 400);
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof LabError) throw err;
    throw new LabError("INVALID_JSON", "request body is not valid JSON", 400);
  }
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-request-id", requestId);
  res.end(JSON.stringify(body));
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
    if (path === "/health/live-eval/ready" && method === "GET") {
      const ready = await ctx.liveEvalReady();
      send(res, ready.ready ? 200 : 503, { status: ready.ready ? "ready" : "not_ready", ...ready.details }, requestId);
      return;
    }

    const mutating = method !== "GET" && method !== "HEAD";
    const auth = authorizeLab(req, ctx.cfg, mutating);
    if (auth === "unauthorized") {
      send(res, 401, { error: { code: "UNAUTHORIZED", message: "missing bearer", request_id: requestId } }, requestId);
      return;
    }
    if (auth === "forbidden") {
      send(res, 403, { error: { code: "FORBIDDEN", message: "invalid lab credential", request_id: requestId } }, requestId);
      return;
    }
    if (auth === "read_only") {
      send(res, 403, { error: { code: "FORBIDDEN", message: "read credential cannot mutate", request_id: requestId } }, requestId);
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
    if (path === "/lab/v1/eval" && method === "POST") {
      const body = await readJsonBody(req);
      const sitting = await ctx.orchestrator.startEvaluationSitting(body);
      send(res, 202, { request_id: requestId, occurred_at: utcNow(), evaluation_id: sitting.evaluation_id, sitting }, requestId);
      return;
    }
    const evalEvents = path.match(/^\/lab\/v1\/evals\/([^/]+)\/events$/);
    if (evalEvents && method === "GET") {
      const sitting = await ctx.store.getSitting(evalEvents[1]!);
      if (!sitting) throw new LabError("NOT_FOUND", "evaluation not found", 404);
      const cursor = Number(url.searchParams.get("after") ?? "0");
      const list = await ctx.store.listEvents(sitting.parent_run_id, cursor);
      send(res, 200, { request_id: requestId, evaluation_id: sitting.evaluation_id, events: list, items: list }, requestId);
      return;
    }
    const oneEval = path.match(/^\/lab\/v1\/evals\/([^/]+)$/);
    if (oneEval && method === "GET") {
      const sitting = await ctx.store.getSitting(oneEval[1]!);
      if (!sitting) throw new LabError("NOT_FOUND", "evaluation not found", 404);
      const children = await ctx.store.listChildSessions(sitting.evaluation_id);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), sitting, children }, requestId);
      return;
    }
    if (path === "/lab/v1/reports" && method === "GET") {
      const runs = await ctx.store.listRuns();
      const items: unknown[] = [];
      const sittings = await ctx.store.listSittings();
      const latestSitting = [...sittings].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
      if (latestSitting) {
        items.push({
          report_id: `eval_${latestSitting.evaluation_id}`,
          kind: "EVALUATION_SITTING",
          status: latestSitting.state,
          source_evaluation_ids: [latestSitting.evaluation_id],
          comparison_key: {
            fixture_digest: latestSitting.provenance.fixture_digest,
            evaluator_set_version: latestSitting.provenance.evaluator_set_version,
            oracle_fee_spec_version: latestSitting.provenance.oracle_fee_spec_version,
            atlas_contract_version: latestSitting.provenance.atlas_contract_version,
            atlas_git_revision: latestSitting.provenance.atlas_git_revision,
            model_id: latestSitting.provenance.model_id,
          },
          board: {
            atlas_scripted_contract_percent: null,
            atlas_scripted_rpas_delta_minor: null,
            live_model_task_success_percent: null,
            live_model_safety_gate: null,
          },
          caveat: "Deterministic, scripted, and live-model metrics are never blended. Test Mode does not establish real-world causal uplift.",
        });
      }
      const latestByScenario = (id: string) => [...runs].reverse().find((r) => r.scenario_id === id);
      const det = latestByScenario("suite_qm_v1");
      if (det) {
        const report = await loadSuiteReport(ctx.store, det.run_id);
        items.push({
          report_id: `suite_${det.run_id}`,
          kind: "CONTRACT",
          title: "Deterministic contract suite",
          caveat: "Framework 0 proves programmed public-interface behavior, not Agent Sellability.",
          run_id: det.run_id,
          report,
        });
      }
      const compat = latestByScenario(COMPAT_SCENARIO_ID);
      if (compat) {
        const report = await loadCompatibilityReport(ctx.store, compat.run_id);
        items.push({
          report_id: `compat_${compat.run_id}`,
          kind: "AGENT_COMPATIBILITY",
          title: "Agent Compatibility",
          caveat: "Live-model task success only. Not blended with deterministic contract scores.",
          run_id: compat.run_id,
          report,
        });
      }
      const uplift = latestByScenario(COMMERCIAL_SCENARIO_ID);
      if (uplift) {
        const report = await loadCommercialReport(ctx.store, uplift.run_id);
        items.push({
          report_id: `uplift_${uplift.run_id}`,
          kind: "COMMERCIAL_UPLIFT",
          title: "Commercial Uplift (RPAS)",
          caveat: "n=1 sitting pair exposes an authoritative minor-unit delta only when evidence exists. No uplift percent or CI. Test Mode does not establish real-world causal uplift.",
          run_id: uplift.run_id,
          report,
        });
      }
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), latest: items, best: items, items }, requestId);
      return;
    }
    if (path === "/lab/v1/configurations" && method === "GET") {
      send(res, 200, { request_id: requestId, configurations: await ctx.store.listConfigurations() }, requestId);
      return;
    }
    if (path === "/lab/v1/deterministic-eval" && method === "POST") {
      const run = await ctx.orchestrator.startDeterministicSuite();
      const report = await loadSuiteReport(ctx.store, run.run_id);
      send(res, 201, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
      return;
    }
    if (path === "/lab/v1/agent-compatibility-eval" && method === "POST") {
      const body = await readJsonBody(req);
      const run = await ctx.orchestrator.startAgentCompatibilityEval(body);
      const report = await loadCompatibilityReport(ctx.store, run.run_id);
      send(res, 201, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
      return;
    }
    if (path === "/lab/v1/commercial-uplift-eval" && method === "POST") {
      const body = await readJsonBody(req);
      const run = await ctx.orchestrator.startCommercialUpliftEval(body);
      const report = await loadCommercialReport(ctx.store, run.run_id);
      send(res, 201, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
      return;
    }
    if (path === "/lab/v1/runs" && method === "POST") {
      const body = await readJsonBody(req);
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
    if (path === "/lab/v1/analytics/outcomes" && method === "GET") {
      send(res, 200, envelope(requestId, await analyticsMerchantOutcomes(ctx.store, ctx.orchestrator)), requestId);
      return;
    }
    const suiteEval = path.match(/^\/lab\/v1\/runs\/([^/]+)\/deterministic-eval$/);
    if (suiteEval && method === "GET") {
      const run = await ctx.store.getRun(suiteEval[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const report = await loadSuiteReport(ctx.store, run.run_id);
      if (!report) throw new LabError("NOT_FOUND", "deterministic suite eval not found", 404);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
      return;
    }
    const compatEval = path.match(/^\/lab\/v1\/runs\/([^/]+)\/agent-compatibility-eval$/);
    if (compatEval && method === "GET") {
      const run = await ctx.store.getRun(compatEval[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const report = await loadCompatibilityReport(ctx.store, run.run_id);
      if (!report) throw new LabError("NOT_FOUND", "agent compatibility eval not found", 404);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
      return;
    }
    const upliftEval = path.match(/^\/lab\/v1\/runs\/([^/]+)\/commercial-uplift-eval$/);
    if (upliftEval && method === "GET") {
      const run = await ctx.store.getRun(upliftEval[1]!);
      if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
      const report = await loadCommercialReport(ctx.store, run.run_id);
      if (!report) throw new LabError("NOT_FOUND", "commercial uplift eval not found", 404);
      send(res, 200, { request_id: requestId, occurred_at: utcNow(), run, report }, requestId);
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
      const body = await readJsonBody(req);
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
      const arts = await ctx.store.getArtifactsByReport(report[1]!);
      if (arts.length === 0) {
        send(res, 404, { error: { code: "REPORT_NOT_FOUND", message: "REPORT_NOT_FOUND", request_id: requestId } }, requestId);
        return;
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
    console.error(JSON.stringify({
      level: "error",
      event: "atlaslab_http_failure",
      request_id: requestId,
      method,
      path,
      error_class: err instanceof Error ? err.name : "unknown",
      error_message: err instanceof Error ? err.message : String(err),
    }));
    send(res, 500, { error: { code: "INTERNAL", message: "internal error", request_id: requestId } }, requestId);
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { AddressInfo } from "node:net";
import { startServer } from "../../../apps/atlaslab/src/app.js";
import { SECRET_CANARIES } from "../../../apps/atlaslab/src/redaction.js";

async function serve() {
  const { server, runtime } = await startServer({
    httpAddr: "127.0.0.1:0",
    apiToken: "lab-contract-token",
    openRouterApiKey: "",
    hostBearer: SECRET_CANARIES.HOST_BEARER,
    fixtureControlCredential: SECRET_CANARIES.FIXTURE_CONTROL,
    mockMcp: true,
    mockFixtureReset: true,
  });
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return { server, runtime, base };
}

test("process readiness stays independent from live-eval readiness", async () => {
  const { server, base } = await serve();
  try {
    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as { openrouter_required_for_readiness: boolean; deterministic_ready: boolean };
    assert.equal(body.openrouter_required_for_readiness, false);
    assert.equal(body.deterministic_ready, true);
    const liveEval = await fetch(`${base}/health/live-eval/ready`);
    assert.equal(liveEval.status, 503);
    const liveEvalBody = (await liveEval.json()) as { live_eval_ready: boolean };
    assert.equal(liveEvalBody.live_eval_ready, false);
  } finally {
    server.close();
  }
});

test("GET /lab/v1/capabilities exposes independent readiness", async () => {
  const { server, base } = await serve();
  try {
    const res = await fetch(`${base}/lab/v1/capabilities`, {
      headers: { authorization: "Bearer lab-contract-token" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      deterministic: { ready: boolean };
      model: { ready: boolean; health: string };
      default_model_id: string | null;
    };
    assert.equal(body.deterministic.ready, true);
    assert.equal(body.model.ready, false);
    assert.equal(body.model.health, "missing");
    assert.equal(body.default_model_id, null);
  } finally {
    server.close();
  }
});

test("POST /lab/v1/runs requires bearer and rejects wrong variant", async () => {
  const { server, base } = await serve();
  try {
    const unauth = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" }),
    });
    assert.equal(unauth.status, 401);
    const forbidden = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" }),
    });
    assert.equal(forbidden.status, 403);
    const wrong = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lab-contract-token" },
      body: JSON.stringify({
        run_type: "DETERMINISTIC_SCENARIO",
        scenario_id: "scn_qm_discovery_v1",
        model_id: "openrouter/sneaky",
      }),
    });
    assert.equal(wrong.status, 400);
    const body = (await wrong.json()) as { error: { code: string } };
    assert.equal(body.error.code, "WRONG_VARIANT");
  } finally {
    server.close();
  }
});

test("Lab HTTP rejects malformed and oversized request bodies", async () => {
  const { server, base } = await serve();
  const headers = { "content-type": "application/json", authorization: "Bearer lab-contract-token" };
  try {
    const malformed = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers,
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: string } }).error.code, "INVALID_JSON");

    const oversized = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ custom_user_input: "x".repeat(1_048_576) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(((await oversized.json()) as { error: { code: string } }).error.code, "PAYLOAD_TOO_LARGE");
  } finally {
    server.close();
  }
});

test("deterministic run over Lab HTTP works without OpenRouter", async () => {
  const { server, base } = await serve();
  try {
    const created = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lab-contract-token" },
      body: JSON.stringify({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" }),
    });
    assert.equal(created.status, 201);
    const envelope = (await created.json()) as { run: { run_id: string; run_type: string; evidence_eligibility: string } };
    assert.equal(envelope.run.run_type, "DETERMINISTIC_SCENARIO");
    assert.equal(envelope.run.evidence_eligibility, "CONTRACT_EVIDENCE_ONLY");
    const auth = { authorization: "Bearer lab-contract-token" };
    const events = await fetch(`${base}/lab/v1/runs/${envelope.run.run_id}/events`, { headers: auth });
    assert.equal(events.status, 200);
    const page = (await events.json()) as { events: Array<{ source: string }> };
    const sources = new Set(page.events.map((e) => e.source));
    assert.equal(sources.has("MODEL_VISIBLE"), false);
    assert.equal(sources.has("ATLASLAB_ORCHESTRATOR"), true);
    const evals = await fetch(`${base}/lab/v1/runs/${envelope.run.run_id}/evaluations`, { headers: auth });
    assert.equal(evals.status, 200);
  } finally {
    server.close();
  }
});

test("model run creation is 409 when OpenRouter is unset", async () => {
  const { server, base } = await serve();
  try {
    const res = await fetch(`${base}/lab/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lab-contract-token" },
      body: JSON.stringify({ run_type: "BENCHMARK_MODEL", scenario_id: "scn_qm_breakfast_180_v1", model_id: "or/x" }),
    });
    assert.equal(res.status, 409);
  } finally {
    server.close();
  }
});

test("POST /lab/v1/deterministic-eval is 409 when mock MCP is on", async () => {
  const { server, base } = await serve();
  try {
    const res = await fetch(`${base}/lab/v1/deterministic-eval`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lab-contract-token" },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "ATLAS_REQUIRED");
  } finally {
    server.close();
  }
});

test("POST live model eval suites are 409 without OpenRouter or real Atlas", async () => {
  const { server, base } = await serve();
  try {
    for (const path of ["/lab/v1/agent-compatibility-eval", "/lab/v1/commercial-uplift-eval"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer lab-contract-token" },
        body: JSON.stringify({ model_id: "or/x" }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: { code: string } };
      assert.ok(["ATLAS_REQUIRED", "MODEL_UNAVAILABLE"].includes(body.error.code));
    }
  } finally {
    server.close();
  }
});

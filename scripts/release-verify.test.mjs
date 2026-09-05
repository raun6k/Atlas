import assert from "node:assert/strict";
import test from "node:test";

import {
  selectedGates,
  validateCommercialArtifact,
  VerificationError,
  verifyRuntime,
} from "./release-verify.mjs";

const head = "0123456789abcdef";
const now = Date.parse("2026-09-05T12:00:00.000Z");

function proof(overrides = {}) {
  return {
    generated_at: "2026-09-05T11:30:00.000Z",
    git_revision: head,
    provider_backed: true,
    razorpay_test_mode: true,
    settlement_status: "NOT_IMPLEMENTED",
    proof: { eligible_pairs: 1 },
    provider_evidence: [
      {
        arm: "CONTROL",
        authenticated_provider_event_ref: "evt_control",
        provider_fetch_ref: "fetch_control",
        provider_payment_id: "pay_control",
        core_order_confirmed: true,
      },
      {
        arm: "TREATMENT",
        authenticated_provider_event_ref: "evt_treatment",
        provider_fetch_ref: "fetch_treatment",
        provider_payment_id: "pay_treatment",
        core_order_confirmed: true,
      },
    ],
    ...overrides,
  };
}

test("release gates default to strict all and allow explicit static-only CI", () => {
  assert.deepEqual(selectedGates({}), ["static", "runtime", "commercial"]);
  assert.deepEqual(selectedGates({ ATLAS_RELEASE_STATIC_ONLY: "1" }), ["static"]);
  assert.deepEqual(selectedGates({ ATLAS_RELEASE_MODE: "commercial" }), ["commercial"]);
});

test("commercial proof accepts fresh provider evidence for both arms", () => {
  assert.doesNotThrow(() => validateCommercialArtifact(proof(), { head, now, maxAgeSeconds: 3600 }));
});

test("commercial proof rejects stale, mismatched, and synthetic evidence", () => {
  assert.throws(
    () => validateCommercialArtifact(proof({ git_revision: "different" }), { head, now, maxAgeSeconds: 3600 }),
    VerificationError,
  );
  assert.throws(
    () => validateCommercialArtifact(proof({ generated_at: "2026-09-01T00:00:00.000Z" }), { head, now, maxAgeSeconds: 3600 }),
    /older than/,
  );
  const synthetic = proof();
  synthetic.provider_evidence[0].provider_fetch_ref = "mock_fabric_capture";
  assert.throws(
    () => validateCommercialArtifact(synthetic, { head, now, maxAgeSeconds: 3600 }),
    /cannot satisfy provider proof/,
  );
});

test("commercial proof requires complete evidence for each arm", () => {
  const incomplete = proof();
  incomplete.provider_evidence[1].core_order_confirmed = false;
  assert.throws(
    () => validateCommercialArtifact(incomplete, { head, now, maxAgeSeconds: 3600 }),
    /TREATMENT must have authenticated event/,
  );
});

test("runtime verification proves protected-tool authentication ordering", async () => {
  const calls = [];
  const response = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health/live-eval/ready")) {
      return response(200, { status: "ready", live_eval_ready: true });
    }
    if (url.endsWith("/health/ready")) return response(200, { status: "ready" });
    const request = JSON.parse(options.body);
    if (request.method === "initialize") {
      return response(200, { result: { serverInfo: { name: "atlas.merchant.v1" } } });
    }
    if (request.method === "tools/list") return response(200, { result: { tools: [{ name: "create_session" }] } });
    if (!options.headers.authorization) {
      return response(401, { error: { message: "HOST_UNAUTHENTICATED" } });
    }
    return response(200, { error: { code: -32602, data: { code: "INVALID_ARGUMENT" } } });
  };

  await verifyRuntime({
    env: { ATLAS_MCP_HOST_TOKEN: "host-token" },
    fetchImpl,
  });

  const toolCalls = calls.filter((call) => call.options.body && JSON.parse(call.options.body).method === "tools/call");
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].options.headers.authorization, undefined);
  assert.equal(toolCalls[1].options.headers.authorization, "Bearer host-token");
});

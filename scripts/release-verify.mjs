#!/usr/bin/env node
/**
 * Release evidence gates. Static checks prove repository shape, runtime checks
 * prove the live stack, and commercial checks prove a fresh provider-backed pair.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class VerificationError extends Error {}

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = join(dirname(modulePath), "..");
const requiredReadmeText = [
  "Track 1",
  "Public MCP",
  "Payment flow",
  "Test Mode",
  "Webhook",
  "Runner",
  "Fixture reset",
  "AtlasLab",
  "Evidence",
  "Dashboard routes",
  "demo",
  "does not claim real-world causal revenue uplift",
  "Settlement is not implemented",
];

function assert(condition, message) {
  if (!condition) throw new VerificationError(message);
}

export function selectedGates(env = process.env) {
  const mode = env.ATLAS_RELEASE_MODE || (env.ATLAS_RELEASE_STATIC_ONLY === "1" ? "static" : "all");
  const selections = {
    static: ["static"],
    runtime: ["runtime"],
    commercial: ["commercial"],
    all: ["static", "runtime", "commercial"],
  };
  assert(selections[mode], `ATLAS_RELEASE_MODE must be static, runtime, commercial, or all (received ${mode})`);
  return selections[mode];
}

export function verifyStatic({ root = defaultRoot, env = process.env } = {}) {
  const page = readFileSync(join(root, "apps/frontend/src/app/page.tsx"), "utf8");
  assert(
    !["process slot", "waiting for a rebuild", "placeholder"].some((text) => page.includes(text)),
    "frontend is still a placeholder",
  );

  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const text of requiredReadmeText) {
    assert(readme.toLowerCase().includes(text.toLowerCase()), `README missing required guidance: ${text}`);
  }
  assert(!existsSync(join(root, "apps/frontend/tests/e2e/stub.spec.ts")), "placeholder browser spec still present");

  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  assert(env.ATLAS_RELEASE_ALLOW_DIRTY === "1" || !dirty, `repository contains uncommitted release changes\n${dirty}`);
  assert(existsSync(join(root, "evidence/README.md")), "tracked evidence/README.md is required for reproducing the ignored provider artifact");
}

async function requestJson(url, options, label, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), ...options });
  } catch (error) {
    throw new VerificationError(`${label} unavailable: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function rpcBody(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

export async function verifyRuntime({ env = process.env, fetchImpl = fetch } = {}) {
  const gateway = (env.ATLAS_GATEWAY_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
  const lab = (env.ATLASLAB_API_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
  const frontend = (env.ATLAS_FRONTEND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const hostToken = env.ATLAS_MCP_HOST_TOKEN || env.ATLASLAB_HOST_BEARER || "";
  const jsonHeaders = { accept: "application/json", "content-type": "application/json" };

  const gatewayReady = await requestJson(`${gateway}/health/ready`, { headers: { accept: "application/json" } }, "Gateway readiness", fetchImpl);
  assert(gatewayReady.response.ok && gatewayReady.body.status === "ready", `Gateway readiness failed (${gatewayReady.response.status})`);

  const labReady = await requestJson(`${lab}/health/live-eval/ready`, { headers: { accept: "application/json" } }, "AtlasLab live-eval readiness", fetchImpl);
  assert(
    labReady.response.ok && labReady.body.status === "ready" && labReady.body.live_eval_ready === true,
    `AtlasLab live-eval readiness failed (${labReady.response.status})`,
  );

  const initialized = await requestJson(
    `${gateway}/mcp`,
    { method: "POST", headers: jsonHeaders, body: rpcBody(1, "initialize", {}) },
    "MCP initialize",
    fetchImpl,
  );
  assert(initialized.response.ok && initialized.body.result?.serverInfo?.name === "atlas.merchant.v1", "MCP initialize failed");

  const listed = await requestJson(
    `${gateway}/mcp`,
    { method: "POST", headers: jsonHeaders, body: rpcBody(2, "tools/list") },
    "MCP tools/list",
    fetchImpl,
  );
  assert(listed.response.ok && listed.body.result?.tools?.length > 0, "MCP tools/list is empty");

  const unauthorized = await requestJson(
    `${gateway}/mcp`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: rpcBody(3, "tools/call", { name: "create_session", arguments: {} }),
    },
    "MCP protected-tool unauthenticated probe",
    fetchImpl,
  );
  assert(
    unauthorized.response.status === 401 && unauthorized.body.error?.message === "HOST_UNAUTHENTICATED",
    "MCP must authenticate protected tools before validating arguments",
  );

  assert(hostToken, "ATLAS_MCP_HOST_TOKEN or ATLASLAB_HOST_BEARER is required for the authenticated MCP ordering probe");
  const authenticated = await requestJson(
    `${gateway}/mcp`,
    {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${hostToken}` },
      body: rpcBody(4, "tools/call", { name: "create_session", arguments: {} }),
    },
    "MCP protected-tool authenticated probe",
    fetchImpl,
  );
  assert(
    authenticated.response.ok &&
      authenticated.body.error?.code === -32602 &&
      authenticated.body.error?.data?.code === "INVALID_ARGUMENT",
    "MCP authenticated protected tool did not proceed from authentication to argument validation",
  );

  const frontendReady = await requestJson(`${frontend}/health/ready`, { headers: { accept: "application/json" } }, "Frontend readiness", fetchImpl);
  assert(frontendReady.response.ok && frontendReady.body.status === "ready", `Frontend readiness failed (${frontendReady.response.status})`);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateCommercialArtifact(
  artifact,
  { head, now = Date.now(), maxAgeSeconds = 24 * 60 * 60 } = {},
) {
  assert(artifact && typeof artifact === "object" && !Array.isArray(artifact), "provider commercial proof must be a JSON object");
  assert(nonEmpty(head) && artifact.git_revision === head, "provider commercial proof git revision does not match HEAD");

  const generatedAt = Date.parse(artifact.generated_at);
  assert(Number.isFinite(generatedAt), "provider commercial proof generated_at is invalid");
  const ageMs = now - generatedAt;
  assert(ageMs >= -5 * 60_000, "provider commercial proof is dated in the future");
  assert(ageMs <= maxAgeSeconds * 1000, `provider commercial proof is older than ${maxAgeSeconds} seconds`);

  assert(artifact.provider_backed === true, "provider commercial proof must set provider_backed=true");
  assert(artifact.razorpay_test_mode === true, "provider commercial proof must set razorpay_test_mode=true");
  assert(artifact.settlement_status === "NOT_IMPLEMENTED", "provider commercial proof must state settlement is NOT_IMPLEMENTED");
  assert(artifact.operator_assisted === true, "provider commercial proof must label the Razorpay path as operator-assisted");
  assert(Number(artifact.proof?.eligible_pairs) > 0, "provider commercial proof must contain eligible_pairs > 0");
  assert(nonEmpty(artifact.fixture_digest), "provider commercial proof must include fixture_digest");
  assert(nonEmpty(artifact.content_digest), "provider commercial proof must include content_digest");
  assert(nonEmpty(artifact.run_id) && nonEmpty(artifact.report_id), "provider commercial proof must include run_id and report_id");

  const evidence = artifact.provider_evidence;
  assert(Array.isArray(evidence), "provider commercial proof must contain provider_evidence");
  for (const arm of ["CONTROL", "TREATMENT"]) {
    const rows = evidence.filter((row) => row?.arm === arm);
    assert(rows.length > 0, `provider commercial proof is missing ${arm} evidence`);
    assert(
      rows.some((row) =>
        nonEmpty(row.authenticated_provider_event_ref) &&
        nonEmpty(row.provider_fetch_ref) &&
        nonEmpty(row.provider_payment_id) &&
        row.provider_payment_id.startsWith("pay_") &&
        row.core_order_confirmed === true),
      `${arm} must have authenticated event, provider fetch, provider payment, and confirmed-order evidence`,
    );
  }

  const provenance = JSON.stringify(evidence).toLowerCase();
  assert(
    !/(^|[^a-z])(deterministic|mock|fabric|simulated)([^a-z]|$)/.test(provenance),
    "deterministic, mock, fabric, or simulated evidence cannot satisfy provider proof",
  );
}

export function loadCommercialArtifact({ root = defaultRoot, env = process.env, now = Date.now() } = {}) {
  const artifactPath = join(root, "artifacts/provider-commercial-proof.json");
  assert(existsSync(artifactPath), "artifacts/provider-commercial-proof.json is required; generate it with `node scripts/provider-commercial-proof.mjs` after the last fixture-reset suite");
  const maxAgeSeconds = Number(env.ATLAS_RELEASE_PROOF_MAX_AGE_SECONDS || 24 * 60 * 60);
  assert(Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0, "ATLAS_RELEASE_PROOF_MAX_AGE_SECONDS must be positive");

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  validateCommercialArtifact(artifact, { head, now, maxAgeSeconds });

  const mtimeAgeMs = now - statSync(artifactPath).mtimeMs;
  assert(mtimeAgeMs >= -5 * 60_000, "provider commercial proof file is dated in the future");
  assert(mtimeAgeMs <= maxAgeSeconds * 1000, `provider commercial proof file is older than ${maxAgeSeconds} seconds`);
  return artifact;
}

export async function crossCheckCommercialRuntime({ artifact, env = process.env, fetchImpl = fetch } = {}) {
  const lab = (env.ATLASLAB_API_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
  const gateway = (env.ATLAS_GATEWAY_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
  const token = env.ATLASLAB_API_TOKEN || env.ATLASLAB_SERVICE_TOKEN || "";
  const hostToken = env.ATLAS_MCP_HOST_TOKEN || env.ATLASLAB_HOST_BEARER || env.ATLAS_TEST_FIXTURE_BEARER || "";
  assert(token, "ATLASLAB_API_TOKEN is required to cross-check the current Lab report");
  assert(artifact.run_id && artifact.report_id, "provider commercial proof must include run_id and report_id");

  const reports = await requestJson(
    `${lab}/lab/v1/reports`,
    { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
    "AtlasLab reports",
    fetchImpl,
  );
  assert(reports.response.ok, `AtlasLab reports failed (${reports.response.status})`);
  const items = Array.isArray(reports.body.items) ? reports.body.items : Array.isArray(reports.body) ? reports.body : [];
  const match = items.find((item) => item.run_id === artifact.run_id || item.report_id === artifact.report_id);
  assert(match, "current AtlasLab reports do not contain the provider proof run_id/report_id");
  const report = match.report || match;
  assert(nonEmpty(artifact.fixture_digest), "provider commercial proof must include fixture_digest");
  assert(nonEmpty(report.fixture_digest) || nonEmpty(report.provenance?.fixture_digest), "Lab report is missing fixture_digest");
  const reportFixture = report.fixture_digest || report.provenance?.fixture_digest;
  assert(reportFixture === artifact.fixture_digest, "Lab report fixture digest does not match the provider artifact");
  if (report.proof && artifact.proof) {
    assert(Number(report.proof.eligible_pairs) === Number(artifact.proof.eligible_pairs), "Lab report eligible_pairs does not match the provider artifact");
  }
  const reportDigest = report.provenance?.content_digest || report.content_digest;
  assert(nonEmpty(artifact.content_digest), "provider commercial proof must include content_digest");
  assert(nonEmpty(reportDigest), "Lab report is missing content_digest");
  assert(artifact.content_digest === reportDigest, "Lab report content digest does not match the provider artifact");

  const hostRequired = (artifact.provider_evidence || []).some((row) => row.core_order_confirmed);
  if (hostRequired) {
    assert(hostToken, "ATLAS_MCP_HOST_TOKEN is required to cross-check Core evidence for confirmed orders");
  }
  for (const row of artifact.provider_evidence || []) {
    if (!row.core_order_confirmed) continue;
    assert(row.session_id, `${row.arm || "arm"} confirmed evidence is missing session_id`);
    const evidence = await requestJson(
      `${gateway}/eval/v1/evidence?session_id=${encodeURIComponent(row.session_id)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${hostToken}` } },
      "Core evidence",
      fetchImpl,
    );
    assert(evidence.response.ok, `Core evidence fetch failed for ${row.arm || row.session_id} (${evidence.response.status})`);
    const body = evidence.body;
    if (row.merchant_order_id) {
      assert(body.merchant_order_id === row.merchant_order_id, "Core merchant order ID does not match the provider artifact");
    }
    if (row.provider_payment_id) {
      assert(body.provider_payment_id === row.provider_payment_id, "Core provider payment ID does not match the provider artifact");
    }
    assert(body.core_order_confirmed === true, "current Core evidence does not confirm the artifact order");
    if (row.provider_order_id) {
      assert(body.provider_order_id === row.provider_order_id, "Core provider order ID does not match the provider artifact");
    }
  }
}

export async function verifyCommercial({ root = defaultRoot, env = process.env, now = Date.now(), fetchImpl = fetch } = {}) {
  const artifact = loadCommercialArtifact({ root, env, now });
  const live = (env.ATLAS_RELEASE_MODE || "all") === "all" || env.ATLAS_RELEASE_CROSSCHECK === "1";
  if (live) {
    await crossCheckCommercialRuntime({ artifact, env, fetchImpl });
  }
  return artifact;
}

export async function run({ root = defaultRoot, env = process.env, fetchImpl = fetch } = {}) {
  const gates = selectedGates(env);
  if (gates.includes("static")) verifyStatic({ root, env });
  if (gates.includes("runtime")) await verifyRuntime({ env, fetchImpl });
  if (gates.includes("commercial")) await verifyCommercial({ root, env, fetchImpl });
  return gates;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  try {
    const gates = await run();
    console.log(`release-verify OK (${gates.join(", ")})`);
  } catch (error) {
    console.error(`release-verify FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

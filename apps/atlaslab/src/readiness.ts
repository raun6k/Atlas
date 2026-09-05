import { utcNow } from "./ids.js";
import { PUBLIC_MCP_TOOLS, type ReadinessCheck, type ReadinessName } from "./types.js";
import type { AtlasLabConfig } from "./config.js";
import { isApprovedModel, modelRunsReady } from "./config.js";
import { argumentDigest, signHostRequestProof, type HostSignerConfig } from "./host/signer.js";
import { redactUnknown } from "./redaction.js";
import type { LabStore } from "./db/store.js";
import type { FixtureResetClient } from "./fixtures/reset-client.js";

export type ReadinessSnapshot = Record<ReadinessName, ReadinessCheck>;

function check(name: ReadinessName, ready: boolean, code: string, diagnostics: Record<string, unknown>): ReadinessCheck {
  return { name, ready, checked_at: utcNow(), code, diagnostics: redactUnknown(diagnostics) as Record<string, unknown> };
}

function originFromMcp(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export async function evaluateReadiness(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  signer?: HostSignerConfig;
  fixtures?: FixtureResetClient;
  includeModel?: boolean;
}): Promise<ReadinessSnapshot> {
  const { cfg } = opts;
  const lab = await evaluateProcessReadiness(cfg, opts.store);
  const mcp = cfg.mockMcp ? check("ATLAS_MCP_READY", false, "MOCK_MCP", { mock_mcp: true }) : await atlasMcpReady(cfg);
  const fixture = cfg.mockFixtureReset
    ? check("FIXTURE_CONTROL_READY", false, "MOCK_FIXTURE_RESET", { mock_fixture_reset: true })
    : await fixtureControlReady(cfg, opts.fixtures);
  const host = cfg.mockMcp || !opts.signer
    ? check("HOST_SIGNING_READY", false, cfg.mockMcp ? "MOCK_MCP" : "SIGNER_MISSING", {})
    : await hostSigningReady(cfg, opts.signer);
  const model = await modelProviderReady(cfg, Boolean(opts.includeModel));
  const payment = cfg.mockMcp ? check("PAYMENT_RAIL_READY", false, "MOCK_MCP", {}) : await paymentRailReady(cfg);
  const liveReady =
    lab.ready &&
    mcp.ready &&
    fixture.ready &&
    host.ready &&
    model.ready &&
    payment.ready &&
    !cfg.mockMcp &&
    !cfg.mockFixtureReset;
  const live = check("LIVE_EVAL_READY", liveReady, liveReady ? "OK" : "NOT_READY", {
    mocks_disabled: !cfg.mockMcp && !cfg.mockFixtureReset,
  });
  return {
    LAB_PROCESS_READY: lab,
    ATLAS_MCP_READY: mcp,
    FIXTURE_CONTROL_READY: fixture,
    HOST_SIGNING_READY: host,
    MODEL_PROVIDER_READY: model,
    PAYMENT_RAIL_READY: payment,
    LIVE_EVAL_READY: live,
  };
}

export async function evaluateProcessReadiness(cfg: AtlasLabConfig, store: LabStore): Promise<ReadinessCheck> {
  const db = await store.ping();
  const version = await store.migrationVersion();
  const authOk = cfg.mode !== "release" || Boolean(cfg.apiWriteToken && cfg.apiReadToken);
  const ready = db && Boolean(version) && authOk;
  return check("LAB_PROCESS_READY", ready, ready ? "OK" : "LAB_PROCESS_NOT_READY", {
    database: db,
    migrations: version,
    release_auth: authOk,
    mode: cfg.mode,
  });
}

async function atlasMcpReady(cfg: AtlasLabConfig): Promise<ReadinessCheck> {
  const origin = originFromMcp(cfg.mcpUrl);
  try {
    const live = await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(4000) });
    const listBody = {
      jsonrpc: "2.0",
      id: "ready_tools",
      method: "tools/list",
      params: {},
    };
    const listed = await fetch(cfg.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.hostBearer}` },
      body: JSON.stringify(listBody),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await listed.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = new Set((json.result?.tools ?? []).map((t) => t.name));
    const toolsOk = PUBLIC_MCP_TOOLS.every((t) => names.has(t));
    const capBody = {
      jsonrpc: "2.0",
      id: "ready_cap",
      method: "tools/call",
      params: { name: "get_capabilities", arguments: {} },
    };
    const cap = await fetch(cfg.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.hostBearer}` },
      body: JSON.stringify(capBody),
      signal: AbortSignal.timeout(5000),
    });
    const capJson = (await cap.json()) as Record<string, unknown>;
    const capOk = cap.ok && !capJson.error;
    const ready = live.ok && listed.ok && toolsOk && capOk && Boolean(cfg.hostBearer);
    return check("ATLAS_MCP_READY", ready, ready ? "OK" : "ATLAS_MCP_NOT_READY", {
      gateway_live: live.ok,
      tools_list: listed.ok,
      public_tools: toolsOk,
      host_bearer: Boolean(cfg.hostBearer),
      get_capabilities: capOk,
      contract_version: cfg.atlasContractVersion,
    });
  } catch (err) {
    return check("ATLAS_MCP_READY", false, "ATLAS_MCP_UNREACHABLE", { error: err instanceof Error ? err.message : "unreachable" });
  }
}

async function fixtureControlReady(cfg: AtlasLabConfig, fixtures?: FixtureResetClient): Promise<ReadinessCheck> {
  if (!cfg.fixtureControlCredential) {
    return check("FIXTURE_CONTROL_READY", false, "FIXTURE_CREDENTIAL_MISSING", {});
  }
  try {
    const current = fixtures
      ? await fixtures.current()
      : ((await (
          await fetch(new URL("/test/v1/fixtures/current", originFromMcp(cfg.mcpUrl)), {
            headers: { authorization: `Bearer ${cfg.fixtureControlCredential}` },
            signal: AbortSignal.timeout(5000),
          })
        ).json()) as { fixture_snapshot_id?: string; digest?: string; contentDigest?: string });
    const snapshot = (current as { fixture_snapshot_id?: string }).fixture_snapshot_id ?? cfg.fixtureSnapshotId;
    const digest = (current as { digest?: string; contentDigest?: string }).digest ?? (current as { contentDigest?: string }).contentDigest ?? null;
    const ready = Boolean(snapshot && digest);
    return check("FIXTURE_CONTROL_READY", ready, ready ? "OK" : "FIXTURE_DIGEST_MISSING", {
      snapshot_id: snapshot,
      digest_present: Boolean(digest),
    });
  } catch (err) {
    return check("FIXTURE_CONTROL_READY", false, "FIXTURE_CONTROL_UNREACHABLE", { error: err instanceof Error ? err.message : "unreachable" });
  }
}

async function hostSigningReady(cfg: AtlasLabConfig, signer: HostSignerConfig): Promise<ReadinessCheck> {
  try {
    const proof = await signHostRequestProof({
      signer,
      requestId: "ready_probe",
      tool: "create_session",
      args: { location_id: "loc_qm_koramangala" },
      idempotencyKey: "ready_idem",
    });
    const body = {
      jsonrpc: "2.0",
      id: "ready_sign",
      method: "tools/call",
      params: {
        name: "get_capabilities",
        arguments: {},
        _meta: { "com.atlas/request": { request_id: "ready_sign", host_request_proof: proof } },
      },
    };
    const res = await fetch(cfg.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.hostBearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    const ready = res.ok && !json.error && Boolean(proof) && Boolean(argumentDigest({ location_id: "loc_qm_koramangala" }));
    return check("HOST_SIGNING_READY", ready, ready ? "OK" : "HOST_PROOF_REJECTED", { gateway_accepted: ready });
  } catch (err) {
    return check("HOST_SIGNING_READY", false, "HOST_SIGNING_FAILED", { error: err instanceof Error ? err.message : "failed" });
  }
}

async function modelProviderReady(cfg: AtlasLabConfig, probe: boolean): Promise<ReadinessCheck> {
  if (!cfg.openRouterApiKey) {
    return check("MODEL_PROVIDER_READY", false, "OPENROUTER_KEY_MISSING", {});
  }
  if (!cfg.approvedModelIds.length) {
    return check("MODEL_PROVIDER_READY", false, "NO_APPROVED_MODELS", {});
  }
  if (!probe) {
    return check("MODEL_PROVIDER_READY", modelRunsReady(cfg), modelRunsReady(cfg) ? "OK" : "NOT_READY", {
      approved_models: cfg.approvedModelIds,
      cheap_model_policy: true,
      fallback_disabled: true,
    });
  }
  try {
    const model = cfg.approvedModelIds[0]!;
    if (!isApprovedModel(cfg, model)) {
      return check("MODEL_PROVIDER_READY", false, "UNAPPROVED_MODEL", { model });
    }
    const res = await fetch(`${cfg.openRouterBaseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.openRouterApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    return check("MODEL_PROVIDER_READY", res.ok, res.ok ? "OK" : "PROVIDER_UNREACHABLE", {
      http: res.status,
      fallback_disabled: true,
    });
  } catch (err) {
    return check("MODEL_PROVIDER_READY", false, "PROVIDER_UNREACHABLE", { error: err instanceof Error ? err.message : "unreachable" });
  }
}

export async function paymentRailReady(cfg: AtlasLabConfig): Promise<ReadinessCheck> {
  const origin = originFromMcp(cfg.mcpUrl);
  let gateway = false;
  let runner = false;
  let worker = false;
  try {
    gateway = (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    gateway = false;
  }
  try {
    runner = (await fetch(`${cfg.paymentRunnerUrl}/health/ready`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    runner = false;
  }
  try {
    worker = (await fetch(`${cfg.coreWorkerHealthUrl}/health/ready`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    worker = false;
  }
  const ready = gateway && runner && worker;
  return check("PAYMENT_RAIL_READY", ready, ready ? "OK" : "PAYMENT_RAIL_NOT_READY", {
    delegated_to_core_gateway: true,
    payment_runner: runner,
    core_worker: worker,
    gateway,
  });
}

export function allLiveGates(snapshot: ReadinessSnapshot): boolean {
  return snapshot.LIVE_EVAL_READY.ready;
}

export function deterministicGates(snapshot: ReadinessSnapshot): boolean {
  if (!snapshot.LAB_PROCESS_READY.ready) return false;
  const live = snapshot.ATLAS_MCP_READY.ready && snapshot.FIXTURE_CONTROL_READY.ready && snapshot.HOST_SIGNING_READY.ready;
  const mockDev =
    snapshot.ATLAS_MCP_READY.code === "MOCK_MCP" &&
    snapshot.FIXTURE_CONTROL_READY.code === "MOCK_FIXTURE_RESET";
  return live || mockDev;
}

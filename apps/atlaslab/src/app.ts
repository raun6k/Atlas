import { loadConfig, modelRunsReady, type AtlasLabConfig } from "./config.js";
import { MemoryStore } from "./db/memory-store.js";
import { PostgresStore } from "./db/postgres-store.js";
import { applyMigrations } from "./db/migrate.js";
import type { LabStore } from "./db/store.js";
import { generateEphemeralHostSigner, loadHostSigner, type HostSignerConfig } from "./host/signer.js";
import { HostBoundary } from "./host/boundary.js";
import { HttpMcpClient } from "./mcp/client.js";
import { MockGateway } from "./mcp/mock-gateway.js";
import { MockFixtureResetClient, HttpFixtureResetClient } from "./fixtures/reset-client.js";
import { MockModelAdapter, OpenRouterAdapter, type ModelAdapter } from "./model/adapter.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createLabServer } from "./http/server.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LabRuntime {
  cfg: AtlasLabConfig;
  store: LabStore;
  orchestrator: Orchestrator;
  mockGateway?: MockGateway;
  signer: HostSignerConfig;
}

export async function buildRuntime(overrides: Partial<AtlasLabConfig> = {}, store?: LabStore): Promise<LabRuntime> {
  const cfg = loadConfig(overrides);
  let resolved: LabStore;
  if (store) {
    resolved = store;
  } else if (cfg.postgresUrl && !cfg.mockMcp) {
    await applyMigrations(cfg.postgresUrl);
    const { default: pg } = await import("pg");
    resolved = new PostgresStore(new pg.Pool({ connectionString: cfg.postgresUrl }));
  } else {
    resolved = new MemoryStore();
  }
  let signer: HostSignerConfig;
  const testPem = join(dirname(fileURLToPath(import.meta.url)), "../../../testdata/hostkeys/host_test_private.pem");
  if (cfg.hostSigningKey) {
    signer = await loadHostSigner({ hostId: cfg.hostId, keyId: cfg.hostKeyId, signingKeyPemOrJwk: cfg.hostSigningKey });
  } else if (!cfg.mockMcp && existsSync(testPem)) {
    signer = await loadHostSigner({
      hostId: cfg.hostId,
      keyId: cfg.hostKeyId,
      signingKeyPemOrJwk: readFileSync(testPem, "utf8"),
    });
  } else {
    signer = generateEphemeralHostSigner(cfg.hostId, cfg.hostKeyId);
  }
  const mockGateway = cfg.mockMcp ? new MockGateway() : undefined;
  const mcp = mockGateway ?? new HttpMcpClient(cfg.mcpUrl, [cfg.hostBearer, cfg.openRouterApiKey]);
  const host = new HostBoundary(signer, mcp, resolved, cfg.hostBearer || "test-host-bearer");
  const fixtures = cfg.mockFixtureReset
    ? new MockFixtureResetClient(cfg.fixtureControlCredential || "test-fixture", () => mockGateway?.resetFixture())
    : new HttpFixtureResetClient(originFromMcp(cfg.mcpUrl), cfg.fixtureControlCredential);
  const modelAdapter: ModelAdapter | null = modelRunsReady(cfg)
    ? cfg.openRouterApiKey.startsWith("mock:")
      ? new MockModelAdapter()
      : new OpenRouterAdapter(cfg.openRouterApiKey, cfg.openRouterBaseUrl)
    : null;
  const orchestrator = new Orchestrator(cfg, resolved, host, fixtures, modelAdapter, mockGateway);
  return { cfg, store: resolved, orchestrator, mockGateway, signer };
}

export async function startServer(overrides: Partial<AtlasLabConfig> = {}) {
  const runtime = await buildRuntime(overrides);
  const server = createLabServer({
    orchestrator: runtime.orchestrator,
    store: runtime.store,
    apiToken: runtime.cfg.apiToken,
    live: () => true,
    ready: async () => {
      const db = await runtime.store.ping();
      const version = await runtime.store.migrationVersion();
      return {
        ready: db,
        details: {
          database: db,
          migrations: version,
          openrouter_required_for_readiness: false,
          deterministic_ready: true,
          model_ready: modelRunsReady(runtime.cfg),
        },
      };
    },
  });
  const [host, port] = splitAddr(runtime.cfg.httpAddr);
  await new Promise<void>((resolve) => server.listen(Number(port), host, resolve));
  return { server, runtime };
}

function splitAddr(addr: string): [string, string] {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return ["127.0.0.1", addr];
  return [addr.slice(0, idx), addr.slice(idx + 1)];
}

function originFromMcp(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  return `${u.protocol}//${u.host}`;
}

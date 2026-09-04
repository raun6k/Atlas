import { parseUsdToMicros } from "./ids.js";

export interface AtlasLabConfig {
  httpAddr: string;
  apiToken: string;
  postgresUrl: string;
  mcpUrl: string;
  hostId: string;
  hostKeyId: string;
  hostBearer: string;
  hostSigningKey: string;
  fixtureControlCredential: string;
  fixtureSnapshotId: string;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  maxTurns: number;
  maxToolCalls: number;
  maxWallSeconds: number;
  maxTokens: number;
  maxCostUsdMicros: number;
  defaultBuyerSpendMinor: number;
  customInputMaxChars: number;
  atlasContractVersion: string;
  evaluatorSetVersion: string;
  hostPolicyVersion: string;
  skillRegistryVersion: string;
  systemPromptVersion: string;
  mockMcp: boolean;
  mockFixtureReset: boolean;
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

export function loadConfig(overrides: Partial<AtlasLabConfig> = {}): AtlasLabConfig {
  const cfg: AtlasLabConfig = {
    httpAddr: env("ATLASLAB_HTTP_ADDR", "127.0.0.1:8090"),
    apiToken: env("ATLASLAB_API_TOKEN", ""),
    postgresUrl: env("ATLASLAB_POSTGRES_URL", ""),
    mcpUrl: env("ATLAS_MCP_URL", "http://127.0.0.1:8080/mcp"),
    hostId: env("ATLASLAB_HOST_ID", "host_atlaslab_quickmart"),
    hostKeyId: env("ATLASLAB_HOST_KEY_ID", "lab_key_1"),
    hostBearer: env("ATLASLAB_HOST_BEARER", ""),
    hostSigningKey: env("ATLASLAB_HOST_SIGNING_KEY", "").replace(/\\n/g, "\n"),
    fixtureControlCredential: env("ATLASLAB_FIXTURE_CONTROL_CREDENTIAL", ""),
    fixtureSnapshotId: env("ATLASLAB_FIXTURE_SNAPSHOT_ID", "fix_quickmart_v1"),
    openRouterApiKey: env("OPENROUTER_API_KEY", ""),
    openRouterBaseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    maxTurns: envInt("ATLASLAB_MAX_TURNS", 24),
    maxToolCalls: envInt("ATLASLAB_MAX_TOOL_CALLS", 40),
    maxWallSeconds: envInt("ATLASLAB_MAX_WALL_SECONDS", 900),
    maxTokens: envInt("ATLASLAB_MAX_TOKENS", 100000),
    maxCostUsdMicros: parseUsdToMicros(env("ATLASLAB_MAX_COST_USD", "1.50")),
    defaultBuyerSpendMinor: envInt("ATLASLAB_DEFAULT_BUYER_SPEND_MINOR", 250000),
    customInputMaxChars: envInt("ATLASLAB_CUSTOM_INPUT_MAX_CHARS", 4000),
    atlasContractVersion: env("ATLASLAB_CONTRACT_VERSION", "atlas.merchant.v1"),
    evaluatorSetVersion: env("ATLASLAB_EVALUATOR_SET_VERSION", "eval_v1"),
    hostPolicyVersion: env("ATLASLAB_HOST_POLICY_VERSION", "host_policy_v1"),
    skillRegistryVersion: env("ATLASLAB_SKILL_REGISTRY_VERSION", "skills_v1"),
    systemPromptVersion: env("ATLASLAB_SYSTEM_PROMPT_VERSION", "prompt_v1"),
    mockMcp: env("ATLASLAB_MOCK_MCP", "1") === "1",
    mockFixtureReset: env("ATLASLAB_MOCK_FIXTURE_RESET", "1") === "1",
    ...overrides,
  };
  if (cfg.maxTurns > 24) cfg.maxTurns = 24;
  if (cfg.maxToolCalls > 40) cfg.maxToolCalls = 40;
  if (cfg.maxWallSeconds > 900) cfg.maxWallSeconds = 900;
  if (cfg.maxTokens > 100000) cfg.maxTokens = 100000;
  if (cfg.maxCostUsdMicros > parseUsdToMicros("1.50")) cfg.maxCostUsdMicros = parseUsdToMicros("1.50");
  return cfg;
}

export function modelRunsReady(cfg: AtlasLabConfig): boolean {
  return Boolean(cfg.openRouterApiKey);
}

export function deterministicRunsReady(_cfg: AtlasLabConfig): boolean {
  return true;
}

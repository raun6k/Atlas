import { execFileSync } from "node:child_process";
import { parseUsdToMicros } from "./ids.js";
import type { ExecutionMode } from "./types.js";

export const APPROVED_DEFAULT_MODELS = ["openrouter/openai/gpt-4.1-nano", "openai/gpt-4.1-nano"] as const;

export interface AtlasLabConfig {
  mode: ExecutionMode;
  httpAddr: string;
  apiToken: string;
  apiReadToken: string;
  apiWriteToken: string;
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
  approvedModelIds: string[];
  maxTurns: number;
  maxToolCalls: number;
  maxWallSeconds: number;
  maxTokens: number;
  maxTokensPerTurn: number;
  maxCostUsdMicros: number;
  sittingWallSeconds: number;
  childWallSeconds: number;
  liveSessionReserveUsdMicros: number;
  maxLiveSessions: number;
  defaultBuyerSpendMinor: number;
  customInputMaxChars: number;
  atlasContractVersion: string;
  evaluatorSetVersion: string;
  hostPolicyVersion: string;
  skillRegistryVersion: string;
  systemPromptVersion: string;
  atlasGitRevision: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  razorpayCallbackOrigin: string;
  paymentRunnerUrl: string;
  coreWorkerHealthUrl: string;
  providerAssistedPayments: boolean;
  providerPaymentWaitSeconds: number;
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

function parseMode(raw: string): ExecutionMode {
  if (raw === "development" || raw === "exploratory" || raw === "release") return raw;
  throw new Error("ATLASLAB_MODE must be release, development, or exploratory");
}

function detectGitRevision(): string {
  const fromEnv = env("ATLAS_GIT_REVISION") || env("ATLASLAB_GIT_REVISION");
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function loadConfig(overrides: Partial<AtlasLabConfig> = {}): AtlasLabConfig {
  const mode = overrides.mode ?? parseMode(env("ATLASLAB_MODE", "release"));
  const envMockMcp = env("ATLASLAB_MOCK_MCP", "0") === "1";
  const envMockReset = env("ATLASLAB_MOCK_FIXTURE_RESET", "0") === "1";
  if (mode === "release" && (envMockMcp || envMockReset) && overrides.mockMcp === undefined && overrides.mockFixtureReset === undefined) {
    throw new Error("release mode forbids ATLASLAB_MOCK_MCP / ATLASLAB_MOCK_FIXTURE_RESET; set ATLASLAB_MODE=development");
  }
  const writeToken = env("ATLASLAB_API_WRITE_TOKEN", env("ATLASLAB_API_TOKEN", ""));
  const readToken = env("ATLASLAB_API_READ_TOKEN", writeToken);
  const approvedRaw = env("ATLASLAB_APPROVED_MODEL_IDS", APPROVED_DEFAULT_MODELS.join(","));
  const cfg: AtlasLabConfig = {
    mode,
    httpAddr: env("ATLASLAB_HTTP_ADDR", "127.0.0.1:8090"),
    apiToken: writeToken,
    apiReadToken: readToken,
    apiWriteToken: writeToken,
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
    approvedModelIds: approvedRaw.split(",").map((s) => s.trim()).filter(Boolean),
    maxTurns: envInt("ATLASLAB_MAX_TURNS", 12),
    maxToolCalls: envInt("ATLASLAB_MAX_TOOL_CALLS", 12),
    maxWallSeconds: envInt("ATLASLAB_MAX_WALL_SECONDS", 180),
    maxTokens: envInt("ATLASLAB_MAX_TOKENS", 12000),
    maxTokensPerTurn: envInt("ATLASLAB_MAX_TOKENS_PER_TURN", 768),
    maxCostUsdMicros: parseUsdToMicros(env("ATLASLAB_MAX_COST_USD", "1.00")),
    sittingWallSeconds: envInt("ATLASLAB_SITTING_WALL_SECONDS", 1200),
    childWallSeconds: envInt("ATLASLAB_CHILD_WALL_SECONDS", 180),
    liveSessionReserveUsdMicros: parseUsdToMicros(env("ATLASLAB_LIVE_RESERVE_USD", "0.18")),
    maxLiveSessions: envInt("ATLASLAB_MAX_LIVE_SESSIONS", 6),
    defaultBuyerSpendMinor: envInt("ATLASLAB_DEFAULT_BUYER_SPEND_MINOR", 250000),
    customInputMaxChars: envInt("ATLASLAB_CUSTOM_INPUT_MAX_CHARS", 4000),
    atlasContractVersion: env("ATLASLAB_CONTRACT_VERSION", "atlas.merchant.v1"),
    evaluatorSetVersion: env("ATLASLAB_EVALUATOR_SET_VERSION", "eval_v2_release"),
    hostPolicyVersion: env("ATLASLAB_HOST_POLICY_VERSION", "host_policy_v1"),
    skillRegistryVersion: env("ATLASLAB_SKILL_REGISTRY_VERSION", "skills_v1"),
    systemPromptVersion: env("ATLASLAB_SYSTEM_PROMPT_VERSION", "prompt_v1"),
    atlasGitRevision: detectGitRevision(),
    razorpayKeyId: env("RAZORPAY_KEY_ID", ""),
    razorpayKeySecret: env("RAZORPAY_KEY_SECRET", ""),
    razorpayWebhookSecret: env("RAZORPAY_WEBHOOK_SECRET", ""),
    razorpayCallbackOrigin: env("RAZORPAY_CALLBACK_ORIGIN", ""),
    paymentRunnerUrl: env("ATLAS_PAYMENT_RUNNER_URL", "http://127.0.0.1:8091"),
    coreWorkerHealthUrl: env("ATLAS_WORKER_HEALTH_URL", "http://127.0.0.1:9092"),
    providerAssistedPayments: env("ATLASLAB_PROVIDER_ASSISTED_PAYMENTS", "0") === "1",
    providerPaymentWaitSeconds: envInt("ATLASLAB_PROVIDER_PAYMENT_WAIT_SECONDS", 600),
    mockMcp: envMockMcp,
    mockFixtureReset: envMockReset,
    ...overrides,
  };
  if (overrides.apiToken) {
    cfg.apiToken = overrides.apiToken;
    if (!overrides.apiWriteToken) cfg.apiWriteToken = overrides.apiToken;
    if (!overrides.apiReadToken) cfg.apiReadToken = overrides.apiToken;
  }
  if (cfg.mode === "release") {
    cfg.mockMcp = overrides.mockMcp ?? false;
    cfg.mockFixtureReset = overrides.mockFixtureReset ?? false;
    if ((envMockMcp || envMockReset) && overrides.mockMcp === undefined) {
      cfg.mockMcp = false;
      cfg.mockFixtureReset = false;
    }
  } else if (cfg.mode === "development") {
    cfg.mockMcp = overrides.mockMcp ?? envMockMcp;
    cfg.mockFixtureReset = overrides.mockFixtureReset ?? envMockReset;
  }
  if (cfg.maxTurns > 12) cfg.maxTurns = 12;
  if (cfg.maxToolCalls > 12) cfg.maxToolCalls = 12;
  if (cfg.maxWallSeconds > 180) cfg.maxWallSeconds = 180;
  if (cfg.maxTokens > 100000) cfg.maxTokens = 100000;
  if (cfg.maxTokensPerTurn > 768) cfg.maxTokensPerTurn = 768;
  if (cfg.maxCostUsdMicros > parseUsdToMicros("1.50")) cfg.maxCostUsdMicros = parseUsdToMicros("1.50");
  if (cfg.maxLiveSessions > 6) cfg.maxLiveSessions = 6;
  if (cfg.mode === "release" && (cfg.mockMcp || cfg.mockFixtureReset) && !overrides.mockMcp && !overrides.mockFixtureReset) {
    throw new Error("release mode requires real Atlas MCP and fixture control");
  }
  return cfg;
}

export function modelRunsReady(cfg: AtlasLabConfig): boolean {
  return Boolean(cfg.openRouterApiKey) && cfg.approvedModelIds.length > 0;
}

export function deterministicRunsReady(cfg: AtlasLabConfig): boolean {
  if (cfg.mode === "development" && cfg.mockMcp) return true;
  return !cfg.mockMcp;
}

export function mocksAllowed(cfg: AtlasLabConfig): boolean {
  return cfg.mode === "development" && (cfg.mockMcp || cfg.mockFixtureReset);
}

export function isApprovedModel(cfg: AtlasLabConfig, modelId: string): boolean {
  const wanted = modelId.toLowerCase();
  return cfg.approvedModelIds.some((id) => id.toLowerCase() === wanted || wanted.endsWith(id.toLowerCase()) || id.toLowerCase().endsWith(wanted));
}

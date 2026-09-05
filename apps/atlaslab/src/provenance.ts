import { ORACLE_FEE_SPEC_VERSION } from "./deterministic/world.js";
import type { AtlasLabConfig } from "./config.js";
import type { ReadinessSnapshot } from "./readiness.js";
import type { ExecutionProvenance } from "./types.js";

export function buildProvenance(cfg: AtlasLabConfig, snapshot: ReadinessSnapshot, extra?: Partial<ExecutionProvenance>): ExecutionProvenance {
  return {
    execution_mode: cfg.mode,
    mock_mcp: cfg.mockMcp,
    mock_fixture_reset: cfg.mockFixtureReset,
    provider_mode: cfg.openRouterApiKey ? (cfg.openRouterApiKey.startsWith("mock:") ? "mock" : "openrouter") : "unavailable",
    readiness_snapshot: snapshot,
    atlas_contract_version: cfg.atlasContractVersion,
    atlas_git_revision: cfg.atlasGitRevision,
    evaluator_set_version: cfg.evaluatorSetVersion,
    oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION,
    fixture_snapshot_id: cfg.fixtureSnapshotId,
    fixture_digest: extra?.fixture_digest ?? null,
    model_id: extra?.model_id ?? null,
    ...extra,
  };
}

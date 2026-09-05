import { contentAddressConfiguration } from "../configuration.js";
import type { AtlasLabConfig } from "../config.js";
import { isApprovedModel } from "../config.js";
import { utcNow, newPrefixedId } from "../ids.js";
import { REDACTION_REVISION } from "../redaction.js";
import type { LabStore } from "../db/store.js";
import { newEvaluationId, newLeaseId, newRunId } from "../db/store.js";
import type { HostBoundary } from "../host/boundary.js";
import type { FixtureResetClient } from "../fixtures/reset-client.js";
import type { ModelAdapter } from "../model/adapter.js";
import { LabError, PUBLIC_MCP_TOOLS, type CommercialArm, type EvalSittingRecord, type ExecutionProvenance, type RunRecord } from "../types.js";
import { evaluateReadiness, deterministicGates, allLiveGates } from "../readiness.js";
import { buildProvenance } from "../provenance.js";
import { runDeterministicSuite } from "../deterministic/suite.js";
import { runAgentCompatibilityEval, runCommercialUpliftEval } from "../model-eval/suite.js";
import { DEFAULT_TREATMENT_STRATEGY } from "../model-eval/missions.js";
import { allowlistDigest } from "../evaluator/evidence.js";

const DEFAULT_PLANNED_LIVE = 4;

export async function enqueueEvaluationSitting(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  modelAdapter: ModelAdapter | null;
  signer: Parameters<typeof evaluateReadiness>[0]["signer"];
  body?: Record<string, unknown>;
}): Promise<EvalSittingRecord> {
  const modelId = String(opts.body?.model_id ?? opts.cfg.approvedModelIds[0] ?? "");
  const snapshot = await evaluateReadiness({
    cfg: opts.cfg,
    store: opts.store,
    signer: opts.signer,
    fixtures: opts.fixtures,
    includeModel: Boolean(modelId),
  });
  if (!deterministicGates(snapshot)) {
    throw new LabError("NOT_READY", "deterministic readiness gate failed", 503, { readiness: snapshot });
  }
  if (modelId && !allLiveGates(snapshot) && opts.cfg.mode === "release") {
    throw new LabError("NOT_READY", "live eval readiness gate failed", 503, { readiness: snapshot });
  }
  if (modelId && opts.cfg.mode === "release" && !isApprovedModel(opts.cfg, modelId)) {
    throw new LabError("UNAPPROVED_MODEL", "model is not on the approved cheap-model allowlist", 409);
  }
  const provenance = buildProvenance(opts.cfg, snapshot, { model_id: modelId || null });
  if (opts.cfg.mode === "exploratory") {
    provenance.provider_mode = "exploratory";
  }
  const cfgRec = contentAddressConfiguration(
    {
      run_type: "EVALUATION_SITTING",
      atlas_contract_version: opts.cfg.atlasContractVersion,
      evaluator_set_version: opts.cfg.evaluatorSetVersion,
      fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
      host_policy_version: opts.cfg.hostPolicyVersion,
      payment_simulation: "SUCCESS",
      wall_deadline_seconds: opts.cfg.sittingWallSeconds,
      max_attempts_per_step: 1,
    },
    {
      scenario_id: "lab_eval_sitting",
      scenario_version: "1",
      action_program_id: "ap_eval_sitting",
      action_program_version: "1",
      action_program_digest: "sitting",
    },
  );
  await opts.store.putConfiguration(cfgRec);
  const parentId = newRunId();
  const evaluationId = newEvaluationId();
  const seed = newPrefixedId("seed");
  const firstArm: CommercialArm = Math.random() < 0.5 ? "CONTROL" : "TREATMENT";
  const parent: RunRecord = {
    run_id: parentId,
    run_type: "EVALUATION_SITTING",
    configuration_id: cfgRec.configuration_id,
    configuration_digest: cfgRec.configuration_digest,
    evidence_eligibility: opts.cfg.mode === "exploratory" ? "EXPLORATORY" : "CONTRACT_EVIDENCE_ONLY",
    state: "QUEUED",
    fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
    fixture_digest: null,
    arm: null,
    pair_id: null,
    scenario_id: "lab_eval_sitting",
    scenario_version: "1",
    action_program_id: "ap_eval_sitting",
    action_program_digest: "sitting",
    custom_input_digest: null,
    requested_model_id: modelId || null,
    returned_model_id: null,
    terminal_reason: null,
    start_at: utcNow(),
    end_at: null,
    created_at: utcNow(),
    updated_at: utcNow(),
    parent_evaluation_id: evaluationId,
    provenance,
  };
  await opts.store.insertRun(parent, {
    run_id: parentId,
    scenario_id: "lab_eval_sitting",
    scenario_version: "1",
    custom_input_snapshot: null,
    custom_input_digest: null,
    consent_policy: { max_amount_minor: 250000, currency: "INR", capability_id: "pcap_razorpay_test" },
    permitted_actions: [...PUBLIC_MCP_TOOLS],
    structured_criteria: { sitting: true, first_arm: firstArm, seed, treatment_policy: DEFAULT_TREATMENT_STRATEGY, treatment_digest: allowlistDigest([DEFAULT_TREATMENT_STRATEGY]), control_digest: allowlistDigest([]) },
    redaction_revision: REDACTION_REVISION,
  });
  const sitting: EvalSittingRecord = {
    evaluation_id: evaluationId,
    parent_run_id: parentId,
    state: "QUEUED",
    planned_sessions: DEFAULT_PLANNED_LIVE,
    started_sessions: 0,
    completed_sessions: 0,
    failed_sessions: 0,
    excluded_sessions: 0,
    aborted_sessions: 0,
    never_started_sessions: DEFAULT_PLANNED_LIVE,
    spend_usd_micros: 0,
    aborted_reason: null,
    wall_deadline_at: new Date(Date.now() + opts.cfg.sittingWallSeconds * 1000).toISOString(),
    randomization_seed: seed,
    first_arm: firstArm,
    lock: null,
    provenance,
    created_at: utcNow(),
    updated_at: utcNow(),
  };
  await opts.store.putSitting(sitting);
  void runSitting({ ...opts, sitting, parent, modelId, firstArm, provenance }).catch(async (err) => {
    await opts.store.updateSitting(evaluationId, {
      state: "FAILED",
      aborted_reason: err instanceof Error ? err.message : "FAILED",
    });
    await opts.store.updateRun(parentId, { state: "FAILED", terminal_reason: "SITTING_FAILED", end_at: utcNow() });
  });
  return sitting;
}

async function runSitting(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  modelAdapter: ModelAdapter | null;
  sitting: EvalSittingRecord;
  parent: RunRecord;
  modelId: string;
  firstArm: CommercialArm;
  provenance: ExecutionProvenance;
}): Promise<void> {
  const ac = new AbortController();
  const leaseTtlMs = 120_000;
  const acquire = () =>
    opts.store.tryAcquireFixtureLease({
      lease_id: newLeaseId(),
      snapshot_id: opts.cfg.fixtureSnapshotId,
      owner_evaluation_id: opts.sitting.evaluation_id,
      acquired_at: utcNow(),
      heartbeat_at: utcNow(),
      expires_at: new Date(Date.now() + leaseTtlMs).toISOString(),
    });
  let lease = await acquire();
  while (!lease) {
    const sitting = await opts.store.getSitting(opts.sitting.evaluation_id);
    if (sitting?.state === "CANCELLED" || Date.now() > Date.parse(opts.sitting.wall_deadline_at)) break;
    await opts.store.updateSitting(opts.sitting.evaluation_id, { state: "QUEUED", lock: { waiting: true } });
    await new Promise((r) => setTimeout(r, 1000));
    lease = await acquire();
  }
  if (!lease) {
    await opts.store.updateSitting(opts.sitting.evaluation_id, {
      state: "PARTIAL",
      aborted_reason: "FIXTURE_LEASE_TIMEOUT",
      never_started_sessions: DEFAULT_PLANNED_LIVE,
      lock: { waiting: false },
    });
    await opts.store.updateRun(opts.parent.run_id, { state: "PARTIAL", terminal_reason: "FIXTURE_LEASE_TIMEOUT", end_at: utcNow() });
    return;
  }
  await opts.store.updateSitting(opts.sitting.evaluation_id, {
    state: "RUNNING",
    lock: { lease_id: lease.lease_id, owner: opts.sitting.evaluation_id },
  });
  await opts.store.updateRun(opts.parent.run_id, { state: "RUNNING" });
  const beat = setInterval(() => {
    void opts.store.heartbeatLease(lease!.lease_id, new Date(Date.now() + leaseTtlMs).toISOString());
  }, 15_000);
  try {
    await runDeterministicSuite({
      cfg: opts.cfg,
      store: opts.store,
      host: opts.host,
      fixtures: opts.fixtures,
      extraSecrets: opts.extraSecrets,
    });
    if (opts.modelAdapter && opts.modelId) {
      const remainingBudget = () => opts.cfg.maxCostUsdMicros - (opts.sitting.spend_usd_micros ?? 0);
      const pastDeadline = () => Date.now() > Date.parse(opts.sitting.wall_deadline_at);
      const abortLive = remainingBudget() < opts.cfg.liveSessionReserveUsdMicros || pastDeadline() || ac.signal.aborted;
      if (abortLive) {
        await opts.store.updateSitting(opts.sitting.evaluation_id, {
          state: "PARTIAL",
          aborted_reason: pastDeadline() ? "WALL_DEADLINE" : "BUDGET",
          never_started_sessions: DEFAULT_PLANNED_LIVE,
        });
      } else {
        await runAgentCompatibilityEval({
          cfg: opts.cfg,
          store: opts.store,
          host: opts.host,
          fixtures: opts.fixtures,
          extraSecrets: opts.extraSecrets,
          modelAdapter: opts.modelAdapter,
          modelId: opts.modelId,
          sitting: true,
          evaluationId: opts.sitting.evaluation_id,
        });
        const children = await opts.store.listChildSessions(opts.sitting.evaluation_id);
        let spend = 0;
        for (const child of children) {
          const inv = await opts.store.listModelInvocations(child.child_run_id);
          spend += inv.reduce((s, i) => s + (i.cost_usd_micros ?? 0), 0);
        }
        if (opts.cfg.maxCostUsdMicros - spend < opts.cfg.liveSessionReserveUsdMicros || pastDeadline()) {
          await opts.store.updateSitting(opts.sitting.evaluation_id, {
            state: "PARTIAL",
            spend_usd_micros: spend,
            aborted_reason: "BUDGET_OR_DEADLINE",
            aborted_sessions: 2,
            never_started_sessions: 2,
          });
        } else {
          await runCommercialUpliftEval({
            cfg: opts.cfg,
            store: opts.store,
            host: opts.host,
            fixtures: opts.fixtures,
            extraSecrets: opts.extraSecrets,
            modelAdapter: opts.modelAdapter,
            modelId: opts.modelId,
            firstArm: opts.firstArm,
            sitting: true,
            evaluationId: opts.sitting.evaluation_id,
          });
        }
      }
    }
    const current = await opts.store.getSitting(opts.sitting.evaluation_id);
    if (current && current.state !== "PARTIAL" && current.state !== "CANCELLED") {
      await opts.store.updateSitting(opts.sitting.evaluation_id, { state: "COMPLETED" });
      await opts.store.updateRun(opts.parent.run_id, { state: "COMPLETED", terminal_reason: "SITTING_COMPLETED", end_at: utcNow() });
    }
  } finally {
    clearInterval(beat);
    await opts.store.releaseLease(lease.lease_id, "completed");
  }
}

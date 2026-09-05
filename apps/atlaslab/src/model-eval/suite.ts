import { contentAddressConfiguration } from "../configuration.js";
import type { AtlasLabConfig } from "../config.js";
import { modelRunsReady } from "../config.js";
import { newPrefixedId, utcNow } from "../ids.js";
import { REDACTION_REVISION } from "../redaction.js";
import type { LabStore } from "../db/store.js";
import { newRunId } from "../db/store.js";
import type { HostBoundary } from "../host/boundary.js";
import type { FixtureResetClient } from "../fixtures/reset-client.js";
import { requireMatchingDigest } from "../fixtures/reset-client.js";
import { SkillLoop } from "../model/skill-loop.js";
import type { ModelAdapter } from "../model/adapter.js";
import {
  LabError,
  PUBLIC_MCP_TOOLS,
  type ConsentPolicy,
  type CommercialArm,
  type ModelDriverConfiguration,
  type RunRecord,
  type SessionPolicy,
} from "../types.js";
import { loadFixtureWorld, ORACLE_FEE_SPEC_VERSION, type FixtureWorld } from "../deterministic/world.js";
import type { ToolTrace } from "../deterministic/oracle.js";
import {
  COMMERCIAL_PROGRAM_ID,
  COMMERCIAL_SCENARIO_ID,
  COMPAT_PROGRAM_ID,
  COMPAT_SCENARIO_ID,
  HISTORY_BUYER_ID,
  DEMO_STRATEGIES,
  DEFAULT_TREATMENT_STRATEGY,
  ECONOMIC_OBJECTIVE_VERSION,
  RANKING_VERSION,
  commercialPortfolioMissions,
  compatibilityMissions,
  expectedCommercialSessions,
  expectedCompatibilitySessions,
  isolateOneStrategyCells,
  missionById,
  sittingCompatibilityMissions,
  sittingCommercialMission,
  type LiveMission,
} from "./missions.js";
import { gradeTrajectory } from "./trajectory.js";
import { averageMetrics, evaluateMission, type MissionEval } from "./metrics.js";
import { pairRpas, portfolioDelta, type PairRpas } from "./rpas.js";
import { wrapArtifact, codeRevision } from "../reporter/provenance.js";
import { fetchAtlasEvidence, originFromMcp, allowlistDigest, firstArmFromSeed, revenueEligible } from "../evaluator/evidence.js";
import { assertCanonicalCommercialReport } from "../evaluator/report-invariants.js";
import { toolSchemaDigest } from "../model/tool-schemas.js";

const CONSENT: ConsentPolicy = {
  max_amount_minor: 250000,
  currency: "INR",
  capability_id: "pcap_razorpay_test",
};

const INNER_WALL_MS = 120_000;

export interface CompatibilityReport {
  kind: "agent_compatibility";
  razorpay_test_mode: true;
  evidence_label: string;
  forbidden_claim: string;
  history_source: "synthetic_fixture";
  currency: string;
  fixture_digest: string | null;
  model_id: string;
  oracle_fee_spec_version: string;
  missions: MissionEval[];
  metrics: ReturnType<typeof averageMetrics>;
  expected_openrouter_sessions: number;
  note: string;
}

export interface CommercialReport {
  kind: "commercial_uplift";
  evaluation_scope: "minimal_pair" | "portfolio";
  razorpay_test_mode: true;
  evidence_label: string;
  forbidden_claim: string;
  history_source: "synthetic_fixture";
  currency: string;
  fixture_digest: string | null;
  model_id: string;
  buyer_ids: string[];
  oracle_fee_spec_version: string;
  first_arm: CommercialArm;
  portfolio: ReturnType<typeof portfolioDelta>;
  pairs: PairRpas[];
  strategy_cells: PairRpas[];
  guardrail_table: Array<{
    mission_id: string;
    cell_id?: string;
    included_in_rpas: boolean;
    exclusion_reason: string | null;
    critical_safety_failure: boolean;
  }>;
  expected_openrouter_sessions: number;
  economic_objective_version: string;
  ranking_version: string;
  demo_strategies: string[];
  operator_assisted: true;
  settlement_status: "NOT_IMPLEMENTED";
  caveat: string;
  proof: {
    eligible_pairs: number;
    excluded_pairs: Array<{ mission_id: string; cell_id?: string; reason: string | null }>;
    confirmed_orders_by_arm: { control: number; treatment: number };
    captured_revenue_by_arm: { control: number; treatment: number };
    merchant_net_revenue_by_arm: { control: number; treatment: number };
    conversion_by_arm: { control: number | null; treatment: number | null };
    aov_by_arm: { control: number | null; treatment: number | null };
    units_per_order_by_arm: { control: number | null; treatment: number | null };
    known_no_purchase_count: number;
    task_success_by_arm: { control: number | null; treatment: number | null };
    safety_failures: number;
    unresolved_payment_count: number;
    primary_metric: "merchant_net_revenue_per_eligible_buyer_journey";
    treatment_strategy: string;
    confidence_intervals: { status: "unavailable"; reason: string };
    next_claim_level: { required_eligible_confirmed_order_pairs: number; required_production_randomization: true; current: string };
  };
  provenance?: {
    code_revision: string;
    content_digest: string;
    fixture_digest: string | null;
    model_id: string | null;
    returned_model_id: string | null;
  };
}

function assertLiveReady(cfg: AtlasLabConfig, requireAtlas: boolean): void {
  if (requireAtlas && cfg.mockMcp) {
    throw new LabError("ATLAS_REQUIRED", "live model eval requires real Atlas MCP (ATLASLAB_MOCK_MCP=0)", 409);
  }
  if (!modelRunsReady(cfg)) {
    throw new LabError("MODEL_UNAVAILABLE", "live model eval requires OpenRouter", 409);
  }
}

function modelDriver(cfg: AtlasLabConfig, modelId: string, scenarioId: string): ModelDriverConfiguration {
  return {
    scenario_id: scenarioId,
    scenario_version: "1",
    model_id: modelId,
    system_prompt_version: cfg.systemPromptVersion,
    skill_registry_version: cfg.skillRegistryVersion,
    temperature: 0,
    max_tokens_per_turn: cfg.maxTokensPerTurn,
    max_turns: cfg.maxTurns,
    max_tool_calls: cfg.maxToolCalls,
    token_ceiling: cfg.maxTokens,
    cost_ceiling_usd_micros: cfg.maxCostUsdMicros,
    buyer_spend_minor: cfg.defaultBuyerSpendMinor,
    routing_policy: "exact_model_no_fallback",
    permitted_actions: [...PUBLIC_MCP_TOOLS],
  };
}

async function insertSuiteRun(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  scenarioId: string;
  programId: string;
  modelId: string;
  evaluatorSet: string;
  world: FixtureWorld;
}): Promise<RunRecord> {
  const liveType = opts.scenarioId.includes("commercial") ? "LIVE_COMMERCIAL_SUITE" : "LIVE_COMPATIBILITY_SUITE";
  const cfgRec = contentAddressConfiguration(
    {
      run_type: liveType,
      atlas_contract_version: opts.cfg.atlasContractVersion,
      evaluator_set_version: opts.evaluatorSet,
      fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
      host_policy_version: opts.cfg.hostPolicyVersion,
      payment_simulation: "SUCCESS",
      wall_deadline_seconds: opts.cfg.maxWallSeconds,
      max_attempts_per_step: 1,
    },
    modelDriver(opts.cfg, opts.modelId, opts.scenarioId),
  );
  await opts.store.putConfiguration(cfgRec);
  const runId = newRunId();
  const run: RunRecord = {
    run_id: runId,
    run_type: liveType,
    configuration_id: cfgRec.configuration_id,
    configuration_digest: cfgRec.configuration_digest,
    evidence_eligibility: "BENCHMARK_ELIGIBLE",
    state: "QUEUED",
    fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
    fixture_digest: opts.world.digest,
    arm: null,
    pair_id: null,
    scenario_id: opts.scenarioId,
    scenario_version: "1",
    action_program_id: null,
    action_program_digest: null,
    custom_input_digest: null,
    requested_model_id: opts.modelId,
    returned_model_id: null,
    terminal_reason: null,
    start_at: utcNow(),
    end_at: null,
    created_at: utcNow(),
    updated_at: utcNow(),
  };
  await opts.store.insertRun(run, {
    run_id: runId,
    scenario_id: opts.scenarioId,
    scenario_version: "1",
    custom_input_snapshot: null,
    custom_input_digest: null,
    consent_policy: CONSENT,
    permitted_actions: [...PUBLIC_MCP_TOOLS],
    structured_criteria: { suite: true, oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION, program_id: opts.programId },
    redaction_revision: REDACTION_REVISION,
  });
  return run;
}

async function tracesSince(store: LabStore, runId: string, offset: number): Promise<ToolTrace[]> {
  const all = await store.listToolExchanges(runId);
  return all.slice(offset).map((ex) => ({
    tool: ex.tool_name,
    arguments: ex.proposed_arguments,
    result_code: ex.result_status ?? "UNKNOWN",
    payload: (ex.atlas_response ?? {}) as Record<string, unknown>,
    tool_exchange_id: ex.tool_exchange_id,
  }));
}

async function runInnerSession(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  modelAdapter: ModelAdapter;
  run: RunRecord;
  model: ModelDriverConfiguration;
  mission: LiveMission;
  arm?: CommercialArm | null;
  strategyAllowlist?: string[];
  subjectReference?: string;
  evaluationId?: string;
  abort?: AbortSignal;
}): Promise<{ eval: MissionEval; digest: string }> {
  opts.host.clearRetainedKeys();
  const reset = await opts.fixtures.reset(opts.cfg.fixtureSnapshotId);
  requireMatchingDigest(loadFixtureWorld().digest, reset);
  const childCfg = contentAddressConfiguration(
    {
      run_type: "LIVE_SESSION",
      atlas_contract_version: opts.cfg.atlasContractVersion,
      evaluator_set_version: opts.cfg.evaluatorSetVersion,
      fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
      host_policy_version: opts.cfg.hostPolicyVersion,
      payment_simulation: "SUCCESS",
      wall_deadline_seconds: opts.cfg.childWallSeconds,
      max_attempts_per_step: 1,
    },
    { ...opts.model, scenario_id: opts.mission.mission_id, routing_policy: "exact_model_no_fallback", arm: opts.arm ?? undefined },
  );
  await opts.store.putConfiguration(childCfg);
  const childId = newRunId();
  const child: RunRecord = {
    run_id: childId,
    run_type: "LIVE_SESSION",
    configuration_id: childCfg.configuration_id,
    configuration_digest: childCfg.configuration_digest,
    evidence_eligibility: opts.cfg.mode === "exploratory" ? "EXPLORATORY" : "BENCHMARK_INELIGIBLE",
    state: "RUNNING",
    fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
    fixture_digest: reset.digest,
    arm: opts.arm ?? null,
    pair_id: opts.run.pair_id,
    scenario_id: opts.mission.mission_id,
    scenario_version: "1",
    action_program_id: null,
    action_program_digest: null,
    custom_input_digest: null,
    requested_model_id: opts.model.model_id,
    returned_model_id: null,
    terminal_reason: null,
    start_at: utcNow(),
    end_at: null,
    created_at: utcNow(),
    updated_at: utcNow(),
    parent_evaluation_id: opts.run.run_id,
    provenance: opts.run.provenance,
  };
  await opts.store.insertRun(child, {
    run_id: childId,
    scenario_id: opts.mission.mission_id,
    scenario_version: "1",
    custom_input_snapshot: opts.mission.user_mission,
    custom_input_digest: null,
    consent_policy: CONSENT,
    permitted_actions: [...PUBLIC_MCP_TOOLS],
    structured_criteria: { mission_id: opts.mission.mission_id, arm: opts.arm ?? null },
    redaction_revision: REDACTION_REVISION,
  });
  const policy: SessionPolicy = {
    subjectReference: opts.subjectReference ?? opts.mission.subject_reference,
    strategyAllowlist: opts.strategyAllowlist ?? [],
    constraints: opts.mission.constraints,
    planningBudgetMinor: opts.mission.requirements.budget_minor,
  };
  const loop = new SkillLoop(opts.store, opts.host, opts.modelAdapter);
  const loopResult = await loop.run({
    run: child,
    model: { ...opts.model, max_tokens_per_turn: Math.min(opts.model.max_tokens_per_turn, opts.cfg.maxTokensPerTurn), routing_policy: "exact_model_no_fallback" },
    consent: CONSENT,
    permittedActions: [...PUBLIC_MCP_TOOLS],
    mission: opts.mission.user_mission,
    extraSecrets: opts.extraSecrets,
    deadlineMs: Date.now() + Math.min(INNER_WALL_MS, opts.cfg.childWallSeconds * 1000),
    sessionPolicy: policy,
    abort: opts.abort,
  });
  const traces = await tracesSince(opts.store, child.run_id, 0);
  const stalls = (await opts.store.listEvents(child.run_id)).filter((e) => e.kind === "NO_PROGRESS").length;
  const grade = gradeTrajectory({ mission: opts.mission, world: loadFixtureWorld(), traces, consentMaxMinor: CONSENT.max_amount_minor });
  let evidence = null;
  if (loopResult.publicState.session_id && !opts.cfg.mockMcp) {
    evidence = await fetchAtlasEvidence({
      atlasOrigin: originFromMcp(opts.cfg.mcpUrl),
      hostBearer: opts.cfg.fixtureControlCredential,
      sessionId: loopResult.publicState.session_id,
      signal: opts.abort,
    });
    if (
      opts.arm &&
      opts.cfg.providerAssistedPayments &&
      evidence?.provider_order_id &&
      !revenueEligible(evidence)
    ) {
      await opts.store.appendEvent({
        run_id: opts.run.run_id,
        source: "ATLASLAB_ORCHESTRATOR",
        kind: "OPERATOR_PAYMENT_REQUIRED",
        payload: {
          child_run_id: child.run_id,
          arm: opts.arm,
          mission_id: opts.mission.mission_id,
          session_id: loopResult.publicState.session_id,
          merchant_order_id: evidence.merchant_order_id,
          payment_attempt_id: evidence.payment_attempt_id,
          provider_order_id: evidence.provider_order_id,
          amount_minor: evidence.confirmed_order_amount_minor,
          currency: evidence.currency,
          instruction: "Complete this Razorpay order in Test Mode. Browser success is not payment truth.",
        },
      });
      const deadline = Date.now() + opts.cfg.providerPaymentWaitSeconds * 1000;
      while ((!evidence || !revenueEligible(evidence)) && Date.now() < deadline) {
        if (opts.abort?.aborted) throw new LabError("CANCELLED", "provider-assisted payment wait aborted", 409);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        evidence = await fetchAtlasEvidence({
          atlasOrigin: originFromMcp(opts.cfg.mcpUrl),
          hostBearer: opts.cfg.fixtureControlCredential,
          sessionId: loopResult.publicState.session_id,
          signal: opts.abort,
        });
      }
      await opts.store.appendEvent({
        run_id: opts.run.run_id,
        source: "ATLASLAB_ORCHESTRATOR",
        kind: evidence && revenueEligible(evidence) ? "OPERATOR_PAYMENT_CONFIRMED" : "OPERATOR_PAYMENT_TIMEOUT",
        payload: {
          child_run_id: child.run_id,
          arm: opts.arm,
          mission_id: opts.mission.mission_id,
          session_id: loopResult.publicState.session_id,
          merchant_order_id: evidence?.merchant_order_id,
          payment_attempt_id: evidence?.payment_attempt_id,
          provider_order_id: evidence?.provider_order_id,
          provider_payment_id: evidence?.provider_payment_id,
          authenticated_provider_event_ref: evidence?.authenticated_provider_event_ref,
          provider_fetch_ref: evidence?.provider_fetch_ref,
          payment_attempt_state: evidence?.payment_attempt_state,
          core_order_confirmed: evidence?.core_order_confirmed,
          fixture_digest: evidence?.fixture_digest,
        },
      });
    }
  }
  const ev = evaluateMission({
    mission: opts.mission,
    world: loadFixtureWorld(),
    grade,
    stallEvents: stalls,
    arm: opts.arm ?? undefined,
    evidence: evidence
      ? {
          ...evidence,
          requested_model_id: opts.model.model_id,
          returned_model_id: loopResult.returnedModelId ?? opts.model.model_id,
          prompt_version: opts.cfg.systemPromptVersion,
          system_prompt_version: opts.cfg.systemPromptVersion,
          skill_registry_version: opts.cfg.skillRegistryVersion,
          tool_schema_digest: toolSchemaDigest(),
          control_policy_digest: opts.arm === "CONTROL" ? allowlistDigest(policy.strategyAllowlist ?? []) : evidence.control_policy_digest,
          treatment_policy_digest: opts.arm === "TREATMENT" ? allowlistDigest(policy.strategyAllowlist ?? []) : evidence.treatment_policy_digest,
          code_revision: opts.cfg.atlasGitRevision || codeRevision(),
        }
      : evidence,
  });
  const invocations = await opts.store.listModelInvocations(child.run_id);
  const evaluationId = opts.evaluationId ?? opts.run.parent_evaluation_id;
  if (evaluationId) {
    await opts.store.putChildSession({
      evaluation_id: evaluationId,
      child_run_id: child.run_id,
      arm: opts.arm ?? null,
      mission_id: opts.mission.mission_id,
      buyer_subject: policy.subjectReference ?? null,
      policy_digest: allowlistDigest(policy.strategyAllowlist ?? []),
      strategy_allowlist: policy.strategyAllowlist ?? [],
      fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
      fixture_digest: reset.digest,
      model_id: opts.model.model_id,
      model_invocation_ids: invocations.map((i) => i.invocation_id),
      merchant_order_id: evidence?.merchant_order_id ?? loopResult.publicState.merchant_order_id ?? null,
      payment_attempt_id: evidence?.payment_attempt_id ?? null,
      provider_refs: {
        provider_order_id: evidence?.provider_order_id,
        provider_payment_id: evidence?.provider_payment_id,
      },
      evidence,
      final_state: loopResult.terminalCode,
      external_effect_possible: Boolean(loopResult.publicState.session_id),
    });
  }
  await opts.store.updateRun(child.run_id, { state: "COMPLETED", end_at: utcNow(), returned_model_id: opts.model.model_id });
  return { eval: ev, digest: reset.digest };
}

export async function runAgentCompatibilityEval(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  modelAdapter: ModelAdapter;
  modelId: string;
  requireAtlas?: boolean;
  sitting?: boolean;
  evaluationId?: string;
}): Promise<{ run: RunRecord; report: CompatibilityReport }> {
  const requireAtlas = opts.requireAtlas !== false;
  assertLiveReady(opts.cfg, requireAtlas);
  const world = loadFixtureWorld();
  const run = await insertSuiteRun({
    cfg: opts.cfg,
    store: opts.store,
    scenarioId: COMPAT_SCENARIO_ID,
    programId: COMPAT_PROGRAM_ID,
    modelId: opts.modelId,
    evaluatorSet: "eval_v2_agent_compatibility",
    world,
  });
  await opts.store.appendEvent({
    run_id: run.run_id,
    source: "ATLASLAB_ORCHESTRATOR",
    kind: "SUITE_STARTED",
    payload: { suite: COMPAT_SCENARIO_ID, missions: (opts.sitting ? sittingCompatibilityMissions() : compatibilityMissions()).map((m) => m.mission_id) },
  });
  await opts.store.updateRun(run.run_id, { state: "RUNNING" });
  const model = modelDriver(opts.cfg, opts.modelId, COMPAT_SCENARIO_ID);
  const evals: MissionEval[] = [];
  let lastDigest = world.digest;
  try {
    for (const mission of opts.sitting ? sittingCompatibilityMissions() : compatibilityMissions()) {
      await opts.store.appendEvent({
        run_id: run.run_id,
        source: "ATLASLAB_ORCHESTRATOR",
        kind: "CASE_BEGIN",
        payload: { mission_id: mission.mission_id },
      });
      if (mission.skip_reason) {
        const skipped = evaluateMission({
          mission,
          world,
          grade: gradeTrajectory({ mission, world, traces: [], consentMaxMinor: CONSENT.max_amount_minor }),
        });
        evals.push(skipped);
      } else {
        const inner = await runInnerSession({
          ...opts,
          run,
          model,
          mission,
        });
        lastDigest = inner.digest;
        evals.push(inner.eval);
      }
      await opts.store.appendEvent({
        run_id: run.run_id,
        source: "ATLASLAB_EVALUATOR",
        kind: "CASE_END",
        payload: { mission_id: mission.mission_id, result: evals.at(-1)?.result },
      });
    }
  } catch (err) {
    const code = err instanceof LabError ? err.code : "INFRASTRUCTURE";
    const abortReason = err instanceof Error && !(err instanceof LabError) ? `${code}: ${err.message}` : code;
    const report = compatibilityReport(opts.modelId, lastDigest, [
      ...evals,
      ...compatibilityMissions()
        .filter((m) => !evals.some((e) => e.mission_id === m.mission_id))
        .map((m) => ({
          mission_id: m.mission_id,
          title: m.title,
          result: "INFRASTRUCTURE" as const,
          reason: abortReason,
          checks: [],
          metrics: {
            task_success: null,
            constraint_satisfaction: null,
            tool_efficiency: null,
            offer_comprehension: null,
            transaction_safety: null,
          },
          captured_revenue_minor: null,
          merchant_net_revenue_minor: null,
          contribution_margin_minor: null,
          merchant_funded_discount_minor: null,
          sponsor_funded_discount_minor: null,
          payment_fee_minor: null,
          fulfillment_cost_minor: null,
          units: null,
          all_in_minor: 0,
          paid: false,
          unknown: false,
          known_no_purchase: false,
          public_calls: 0,
          coverage: 0,
          constraint_violations: [],
          safety_failure: false,
          offer_in_play: false,
          offer_funnel: { generated: 0, shown: 0, selected: 0, applied: 0, retained: 0, confirmed: 0, attributed: 0 },
          treatment_policy_reached: false,
          evidence: null,
          safe_refusal: false,
          unauthorized_action: false,
          judgement_matched: null,
          policy_compliant: false,
        })),
    ]);
    await persistCompat(opts.store, run.run_id, report);
    const failed = await opts.store.updateRun(run.run_id, {
      state: "FAILED",
      terminal_reason: abortReason,
      end_at: utcNow(),
      fixture_digest: lastDigest,
    });
    return { run: failed, report };
  }
  const report = compatibilityReport(opts.modelId, lastDigest, evals);
  await persistCompat(opts.store, run.run_id, report);
  const failed = evals.some((e) => e.result === "FAIL");
  const updated = await opts.store.updateRun(run.run_id, {
    state: failed ? "FAILED" : "COMPLETED",
    terminal_reason: failed ? "SUITE_CASE_FAILED" : "SUITE_COMPLETED",
    end_at: utcNow(),
    fixture_digest: lastDigest,
    returned_model_id: opts.modelId,
  });
  return { run: updated, report };
}

function compatibilityReport(modelId: string, digest: string | null, missions: MissionEval[]): CompatibilityReport {
  return {
    kind: "agent_compatibility",
    razorpay_test_mode: true,
    evidence_label: "Core Live Agent Compatibility (4 missions). Not sellability-as-revenue.",
    forbidden_claim: "real-world causal uplift",
    history_source: "synthetic_fixture" as const,
    currency: "INR",
    fixture_digest: digest,
    model_id: modelId,
    oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION,
    missions,
    metrics: averageMetrics(missions.filter((m) => m.result !== "NOT_EVALUATED" && m.result !== "INFRASTRUCTURE")),
    expected_openrouter_sessions: expectedCompatibilitySessions(),
    note: "Core Live only: four CONTROL missions. Not sellability-as-revenue.",
  };
}

function coinFlipArm(seed?: string): CommercialArm {
  if (seed) return firstArmFromSeed(seed);
  return firstArmFromSeed(`${Date.now()}:${Math.random()}`);
}

export async function runCommercialUpliftEval(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  modelAdapter: ModelAdapter;
  modelId: string;
  requireAtlas?: boolean;
  firstArm?: CommercialArm;
  sitting?: boolean;
  evaluationId?: string;
}): Promise<{ run: RunRecord; report: CommercialReport }> {
  const requireAtlas = opts.requireAtlas !== false;
  assertLiveReady(opts.cfg, requireAtlas);
  const world = loadFixtureWorld();
  const run = await insertSuiteRun({
    cfg: opts.cfg,
    store: opts.store,
    scenarioId: COMMERCIAL_SCENARIO_ID,
    programId: COMMERCIAL_PROGRAM_ID,
    modelId: opts.modelId,
    evaluatorSet: "eval_v2_commercial_uplift",
    world,
  });
  const firstArm = opts.firstArm ?? coinFlipArm();
  await opts.store.appendEvent({
    run_id: run.run_id,
    source: "ATLASLAB_ORCHESTRATOR",
    kind: "SUITE_STARTED",
    payload: { suite: COMMERCIAL_SCENARIO_ID, first_arm: firstArm },
  });
  await opts.store.updateRun(run.run_id, { state: "RUNNING" });
  const model = modelDriver(opts.cfg, opts.modelId, COMMERCIAL_SCENARIO_ID);
  const order: CommercialArm[] = firstArm === "CONTROL" ? ["CONTROL", "TREATMENT"] : ["TREATMENT", "CONTROL"];
  const pairs: PairRpas[] = [];
  const cells: PairRpas[] = [];
  let lastDigest = world.digest;
  const buyerIds = new Set<string>([HISTORY_BUYER_ID]);
  try {
    for (const mission of opts.sitting ? [sittingCommercialMission()] : commercialPortfolioMissions()) {
      const byArm: Partial<Record<CommercialArm, MissionEval>> = {};
      for (const arm of order) {
        const inner = await runInnerSession({
          ...opts,
          run,
          model,
          mission,
          arm,
          strategyAllowlist: arm === "TREATMENT" ? (opts.sitting ? [DEFAULT_TREATMENT_STRATEGY] : [...DEMO_STRATEGIES]) : [],
          subjectReference: HISTORY_BUYER_ID,
        });
        lastDigest = inner.digest;
        inner.eval.arm = arm;
        byArm[arm] = inner.eval;
      }
      if (byArm.CONTROL && byArm.TREATMENT) {
        pairs.push(pairRpas({ mission_id: mission.mission_id, control: byArm.CONTROL, treatment: byArm.TREATMENT }));
      }
    }
    for (const cell of opts.sitting ? [] : isolateOneStrategyCells()) {
      const mission = missionById(cell.mission_id);
      if (!mission) continue;
      const subject = cell.subject_reference ?? HISTORY_BUYER_ID;
      buyerIds.add(subject);
      const byArm: Partial<Record<CommercialArm, MissionEval>> = {};
      for (const arm of order) {
        const inner = await runInnerSession({
          ...opts,
          run,
          model,
          mission,
          arm,
          strategyAllowlist: arm === "TREATMENT" ? [cell.strategy] : [],
          subjectReference: subject,
        });
        lastDigest = inner.digest;
        inner.eval.arm = arm;
        inner.eval.cell_id = cell.cell_id;
        byArm[arm] = inner.eval;
      }
      if (byArm.CONTROL && byArm.TREATMENT) {
        cells.push(
          pairRpas({
            mission_id: mission.mission_id,
            control: byArm.CONTROL,
            treatment: byArm.TREATMENT,
            cell_id: cell.cell_id,
            strategy: cell.strategy,
          }),
        );
      }
    }
  } catch (err) {
    const code = err instanceof LabError ? err.code : "INFRASTRUCTURE";
    const report = commercialReport(opts.modelId, lastDigest, firstArm, pairs, cells, [...buyerIds], Boolean(opts.sitting));
    await persistCommercial(opts.store, run.run_id, report);
    const failed = await opts.store.updateRun(run.run_id, {
      state: "FAILED",
      terminal_reason: code,
      end_at: utcNow(),
      fixture_digest: lastDigest,
    });
    return { run: failed, report };
  }
  const report = commercialReport(opts.modelId, lastDigest, firstArm, pairs, cells, [...buyerIds], Boolean(opts.sitting));
  await persistCommercial(opts.store, run.run_id, report);
  const updated = await opts.store.updateRun(run.run_id, {
    state: "COMPLETED",
    terminal_reason: "SUITE_COMPLETED",
    end_at: utcNow(),
    fixture_digest: lastDigest,
    returned_model_id: opts.modelId,
  });
  return { run: updated, report };
}

function commercialReport(
  modelId: string,
  digest: string | null,
  firstArm: CommercialArm,
  pairs: PairRpas[],
  cells: PairRpas[],
  buyerIds: string[],
  minimalPair = false,
): CommercialReport {
  const portfolio = portfolioDelta(pairs);
  const guardrail_table = [...pairs, ...cells].map((p) => ({
    mission_id: p.mission_id,
    cell_id: p.cell_id,
    included_in_rpas: p.included_in_rpas,
    exclusion_reason: p.exclusion_reason,
    critical_safety_failure: p.guardrails.critical_safety_failure,
  }));
  const included = pairs.filter((p) => p.included_in_rpas);
  const excluded_pairs = [...pairs, ...cells]
    .filter((p) => !p.included_in_rpas)
    .map((p) => ({ mission_id: p.mission_id, cell_id: p.cell_id, reason: p.exclusion_reason }));
  const meanTask = (arm: "control" | "treatment"): number | null => {
    const vals = included.map((p) => p[arm].task_success).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  return {
    kind: "commercial_uplift",
    evaluation_scope: minimalPair ? "minimal_pair" : "portfolio",
    razorpay_test_mode: true,
    evidence_label: "The treatment changed RPAS including zeros in this controlled Test Mode evaluation.",
    forbidden_claim: "real-world causal uplift",
    history_source: "synthetic_fixture" as const,
    currency: "INR",
    fixture_digest: digest,
    model_id: modelId,
    buyer_ids: buyerIds,
    oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION,
    first_arm: firstArm,
    portfolio,
    pairs,
    strategy_cells: cells,
    guardrail_table,
    expected_openrouter_sessions: minimalPair ? 2 : expectedCommercialSessions(),
    economic_objective_version: ECONOMIC_OBJECTIVE_VERSION,
    ranking_version: RANKING_VERSION,
    demo_strategies: [...DEMO_STRATEGIES],
    operator_assisted: true,
    settlement_status: "NOT_IMPLEMENTED",
    caveat: minimalPair
      ? "Core Live minimal pair: one frozen fee_threshold buyer mission under CONTROL and one bounded SMALL_ORDER TREATMENT. Payment is operator-assisted Razorpay Test Mode, not autonomous capture. Buyer history is synthetic_fixture, not real market demand. Capture and reconciliation do not establish settlement or real-world causal uplift. Merchant-net delta may be positive, neutral, or unproven; Atlas does not manufacture uplift."
      : "Core Live only: 3 portfolio pairs and 3 isolate-one cells over DEMO strategies (threshold completion, brand promotion, FBT). Buyer history is synthetic_fixture, not real market demand. Portfolio TREATMENT stamps those strategies explicitly. CONTROL stamps an empty allowlist. Payment is operator-assisted Test Mode. n is small; report deltas and caveats, not p-values. Commercial offer success requires an applied offer that is retained through quote validation and confirmed payment, not merely shown.",
    proof: canonicalProof(pairs, cells, included, excluded_pairs, meanTask),
  };
}

function canonicalProof(
  pairs: PairRpas[],
  cells: PairRpas[],
  included: PairRpas[],
  excluded_pairs: Array<{ mission_id: string; cell_id?: string; reason: string | null }>,
  meanTask: (arm: "control" | "treatment") => number | null,
): CommercialReport["proof"] {
  const net = (arm: "control" | "treatment"): number =>
    included.reduce((sum, p) => sum + (p[arm].merchant_net_revenue_minor ?? p[arm].captured_revenue_minor ?? 0), 0);
  const paid = (arm: "control" | "treatment"): number =>
    included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE" && p[arm].paid && p[arm].captured_revenue_minor !== null).length;
  const aov = (arm: "control" | "treatment"): number | null => {
    const rows = included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE" && p[arm].captured_revenue_minor != null);
    if (!rows.length) return null;
    return rows.reduce((sum, p) => sum + (p[arm].captured_revenue_minor ?? 0), 0) / rows.length;
  };
  const units = (arm: "control" | "treatment"): number | null => {
    const rows = included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE" && p[arm].units != null);
    if (!rows.length) return null;
    return rows.reduce((sum, p) => sum + (p[arm].units ?? 0), 0) / rows.length;
  };
  return {
    eligible_pairs: included.length,
    excluded_pairs,
    confirmed_orders_by_arm: { control: paid("control"), treatment: paid("treatment") },
    captured_revenue_by_arm: {
      control: included.reduce((s, p) => s + (p.control.captured_revenue_minor ?? 0), 0),
      treatment: included.reduce((s, p) => s + (p.treatment.captured_revenue_minor ?? 0), 0),
    },
    merchant_net_revenue_by_arm: { control: net("control"), treatment: net("treatment") },
    conversion_by_arm: {
      control: included.length ? paid("control") / included.length : null,
      treatment: included.length ? paid("treatment") / included.length : null,
    },
    aov_by_arm: { control: aov("control"), treatment: aov("treatment") },
    units_per_order_by_arm: { control: units("control"), treatment: units("treatment") },
    known_no_purchase_count: [...pairs, ...cells].filter((p) => p.control.known_no_purchase || p.treatment.known_no_purchase).length,
    task_success_by_arm: { control: meanTask("control"), treatment: meanTask("treatment") },
    safety_failures: [...pairs, ...cells].filter((p) => p.guardrails.critical_safety_failure).length,
    unresolved_payment_count: [...pairs, ...cells].filter((p) => p.control.unknown || p.treatment.unknown).length,
    primary_metric: "merchant_net_revenue_per_eligible_buyer_journey",
    treatment_strategy: DEFAULT_TREATMENT_STRATEGY,
    confidence_intervals: {
      status: "unavailable",
      reason: "n is too small for inferential intervals. Test Mode does not support a real-world causal uplift claim.",
    },
    next_claim_level: {
      required_eligible_confirmed_order_pairs: 30,
      required_production_randomization: true,
      current: included.length === 0
        ? "Revenue uplift unavailable — 0 eligible confirmed-order pairs."
        : (net("treatment") - net("control") > 0
          ? "Controlled Test Mode merchant-net RPAS only. Real merchant evidence is not claimed."
          : "Controlled Test Mode merchant-net result is not positive. Real merchant evidence is not claimed."),
    },
  };
}

async function persistCompat(store: LabStore, runId: string, report: CompatibilityReport): Promise<void> {
  const wrapped = wrapArtifact(report, {
    evaluator_version: "eval_v2_agent_compatibility",
    fixture_digest: report.fixture_digest,
    model_id: report.model_id,
    returned_model_id: report.model_id,
    run_ids: [runId],
    evidence_quality: "measured",
    evidence_level: "controlled_test_mode",
  });
  const body = JSON.stringify({ ...report, provenance: wrapped.provenance });
  await store.putArtifact({
    artifact_id: newPrefixedId("art"),
    report_id: `compat_${runId}`,
    kind: "agent_compatibility.json",
    content_digest: wrapped.provenance.content_digest,
    local_path: null,
    body,
  });
}

async function persistCommercial(store: LabStore, runId: string, report: CommercialReport): Promise<void> {
  const orderIds = report.pairs.flatMap((p) => [p.control.merchant_order_id, p.treatment.merchant_order_id]).filter((id): id is string => Boolean(id));
  const paymentIds = report.pairs.flatMap((p) => [p.control.provider_payment_id, p.treatment.provider_payment_id]).filter((id): id is string => Boolean(id));
  const revision = codeRevision();
  const measured = report.proof.eligible_pairs > 0 && revision !== "unknown";
  const wrapped = wrapArtifact(report, {
    evaluator_version: "eval_v2_commercial_uplift",
    code_revision: revision,
    fixture_snapshot_id: "fix_quickmart_v1",
    fixture_digest: report.fixture_digest,
    model_id: report.model_id,
    returned_model_id: report.model_id,
    prompt_version: report.pairs[0]?.control.prompt_version ?? null,
    system_prompt_version: report.pairs[0]?.control.system_prompt_version ?? null,
    skill_registry_version: report.pairs[0]?.control.skill_registry_version ?? null,
    tool_schema_digest: report.pairs[0]?.control.tool_schema_digest ?? toolSchemaDigest(),
    control_policy_digest: allowlistDigest([]),
    treatment_policy_digest: allowlistDigest([DEFAULT_TREATMENT_STRATEGY]),
    run_ids: [runId],
    order_ids: orderIds,
    payment_ids: paymentIds,
    exclusions: report.proof.excluded_pairs.map((e) => ({ id: e.cell_id ?? e.mission_id, reason: e.reason ?? "excluded" })),
    evidence_quality: measured ? "measured" : report.proof.eligible_pairs === 0 ? "unavailable" : "partial",
    evidence_level: "controlled_test_mode",
  });
  report.provenance = {
    code_revision: wrapped.provenance.code_revision,
    content_digest: wrapped.provenance.content_digest,
    fixture_digest: wrapped.provenance.fixture_digest,
    model_id: wrapped.provenance.model_id,
    returned_model_id: wrapped.provenance.returned_model_id,
  };
  if (measured) {
    assertCanonicalCommercialReport(report);
  }
  const body = JSON.stringify({ ...report, provenance: wrapped.provenance });
  await store.putArtifact({
    artifact_id: newPrefixedId("art"),
    report_id: `uplift_${runId}`,
    kind: "commercial_uplift.json",
    content_digest: wrapped.provenance.content_digest,
    local_path: null,
    body,
  });
}

export async function loadCompatibilityReport(store: LabStore, runId: string): Promise<CompatibilityReport | undefined> {
  const arts = await store.getArtifactsByReport(`compat_${runId}`);
  const art = arts.find((a) => a.kind === "agent_compatibility.json");
  if (!art?.body) return undefined;
  return JSON.parse(art.body) as CompatibilityReport;
}

export async function loadCommercialReport(store: LabStore, runId: string): Promise<CommercialReport | undefined> {
  const arts = await store.getArtifactsByReport(`uplift_${runId}`);
  const art = arts.find((a) => a.kind === "commercial_uplift.json");
  if (!art?.body) return undefined;
  const report = JSON.parse(art.body) as CommercialReport;
  const included = report.pairs.filter((pair) => pair.included_in_rpas);
  const meanTask = (arm: "control" | "treatment"): number | null => {
    const vals = included.map((p) => p[arm].task_success).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const excluded_pairs = [...report.pairs, ...(report.strategy_cells ?? [])]
    .filter((p) => !p.included_in_rpas)
    .map((p) => ({ mission_id: p.mission_id, cell_id: p.cell_id, reason: p.exclusion_reason }));
  report.proof = canonicalProof(report.pairs, report.strategy_cells ?? [], included, excluded_pairs, meanTask);
  if (report.proof.eligible_pairs > 0 && report.provenance?.code_revision && report.provenance.code_revision !== "unknown") {
    assertCanonicalCommercialReport(report);
  }
  return report;
}

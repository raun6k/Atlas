import { contentAddressConfiguration, evidenceForRunType, rejectWrongVariant, type IncomingRunRequest } from "../configuration.js";
import type { AtlasLabConfig } from "../config.js";
import { modelRunsReady } from "../config.js";
import { newPrefixedId, sha256Hex, utcNow } from "../ids.js";
import { canonicalize } from "../canonical.js";
import { REDACTION_REVISION, redactValue } from "../redaction.js";
import type { LabStore } from "../db/store.js";
import { newPairId, newRunId, TERMINAL_STATES } from "../db/store.js";
import { DeterministicDriver } from "../driver/deterministic.js";
import type { HostBoundary } from "../host/boundary.js";
import type { FixtureResetClient } from "../fixtures/reset-client.js";
import { SkillLoop } from "../model/skill-loop.js";
import type { ModelAdapter } from "../model/adapter.js";
import type { MockGateway } from "../mcp/mock-gateway.js";
import { builtinScenarios } from "../scenarios/catalog.js";
import { evaluateRun } from "../evaluator/evaluate.js";
import {
  LabError,
  type ConsentPolicy,
  type DeterministicDriverConfiguration,
  type ModelDriverConfiguration,
  type PairResultRecord,
  type PublicMcpTool,
  type RunRecord,
  type ScenarioDefinition,
} from "../types.js";
import { persistProof, extractRevenueMinor } from "../evaluator/proof.js";
import { pairRuns, relativeUplift } from "../evaluator/framework2.js";

export class Orchestrator {
  readonly scenarios: ScenarioDefinition[];

  constructor(
    private readonly cfg: AtlasLabConfig,
    private readonly store: LabStore,
    private readonly host: HostBoundary,
    private readonly fixtures: FixtureResetClient,
    private readonly modelAdapter: ModelAdapter | null,
    private readonly mockGateway?: MockGateway,
  ) {
    this.scenarios = builtinScenarios();
  }

  extraSecrets(): string[] {
    return [this.cfg.hostBearer, this.cfg.hostSigningKey, this.cfg.openRouterApiKey, this.cfg.fixtureControlCredential, this.cfg.apiToken];
  }

  capabilities() {
    return {
      contract_version: this.cfg.atlasContractVersion,
      deterministic: {
        ready: true,
        reason: "Deterministic Scenario Runs do not use OpenRouter",
      },
      model: {
        ready: modelRunsReady(this.cfg),
        health: this.cfg.openRouterApiKey ? "available" : "missing",
        reason: this.cfg.openRouterApiKey ? "OpenRouter configured" : "OPENROUTER_API_KEY unset; model runs unavailable",
      },
      input_limits: {
        custom_input_max_chars: this.cfg.customInputMaxChars,
        max_turns: this.cfg.maxTurns,
        max_tool_calls: this.cfg.maxToolCalls,
        max_wall_seconds: this.cfg.maxWallSeconds,
        max_tokens: this.cfg.maxTokens,
        max_cost_usd: "1.50",
        default_buyer_spend_minor: this.cfg.defaultBuyerSpendMinor,
        currency: "INR",
      },
      fixtures: [{ fixture_snapshot_id: this.cfg.fixtureSnapshotId }],
      consent_profiles: [
        {
          profile_id: "consent_inr_2500",
          max_amount_minor: this.cfg.defaultBuyerSpendMinor,
          currency: "INR",
          capability_id: "pcap_razorpay_test",
        },
      ],
      default_model_id: null,
    };
  }

  listScenarios() {
    return this.scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      version: s.version,
      title: s.title,
      family: s.family,
      framework: s.framework,
      supported_run_types: s.supported_run_types,
      action_program_available: Boolean(s.action_program),
      pairing_key: s.commercial_eligibility?.pairing_key ?? null,
      payment_simulation: s.payment_simulation,
    }));
  }

  async startRun(body: Record<string, unknown>): Promise<RunRecord> {
    const runType = body.run_type as IncomingRunRequest["run_type"];
    if (runType === "BENCHMARK_MODEL" || runType === "CUSTOM_MISSION") {
      if (!modelRunsReady(this.cfg)) {
        throw new LabError("MODEL_UNAVAILABLE", "model runs require OpenRouter; deterministic runs remain available", 409);
      }
    }
    const incoming = this.parseIncoming(body);
    if (runType === "CUSTOM_MISSION" && incoming.model) {
      const raw = String(body.custom_user_input ?? "");
      if (raw.length > this.cfg.customInputMaxChars) {
        throw new LabError("CUSTOM_INPUT_TOO_LONG", `custom input exceeds ${this.cfg.customInputMaxChars} characters`);
      }
      const snapshot = redactValue(raw, this.extraSecrets());
      incoming.model.custom_input_digest = sha256Hex(canonicalize({ text: snapshot }));
      if (body.custom_input_digest && body.custom_input_digest !== incoming.model.custom_input_digest) {
        throw new LabError("CUSTOM_INPUT_IMMUTABLE", "custom input digest mismatch; editing creates a new run");
      }
    }
    rejectWrongVariant(incoming);
    const cfgRec = contentAddressConfiguration(incoming.common, incoming.deterministic ?? incoming.model!);
    await this.store.putConfiguration(cfgRec);

    let scenario: ScenarioDefinition | undefined;
    let customSnapshot: string | null = null;
    let customDigest: string | null = null;
    let consent: ConsentPolicy = {
      max_amount_minor: this.cfg.defaultBuyerSpendMinor,
      currency: "INR",
      capability_id: "pcap_razorpay_test",
    };
    let permitted: PublicMcpTool[] = incoming.model?.permitted_actions ?? (this.scenarios[0]?.permitted_actions as PublicMcpTool[]);

    if (runType === "CUSTOM_MISSION") {
      const raw = String(body.custom_user_input ?? "");
      customSnapshot = redactValue(raw, this.extraSecrets());
      customDigest = incoming.model?.custom_input_digest ?? null;
      consent = (body.consent_policy as ConsentPolicy) ?? consent;
      permitted = (body.permitted_actions as PublicMcpTool[]) ?? permitted;
    } else {
      const sid = incoming.deterministic?.scenario_id ?? incoming.model?.scenario_id;
      scenario = this.scenarios.find((s) => s.scenario_id === sid);
      if (!scenario) throw new LabError("NOT_FOUND", `scenario ${sid} not found`, 404);
      if (!scenario.supported_run_types.includes(runType === "DETERMINISTIC_SCENARIO" ? "DETERMINISTIC_SCENARIO" : "BENCHMARK_MODEL")) {
        throw new LabError("WRONG_VARIANT", "scenario does not support this run type");
      }
      consent = scenario.consent_policy;
      permitted = scenario.permitted_actions;
    }

    const runId = newRunId();
    const eligibility = evidenceForRunType(runType);
    const run: RunRecord = {
      run_id: runId,
      run_type: runType,
      configuration_id: cfgRec.configuration_id,
      configuration_digest: cfgRec.configuration_digest,
      evidence_eligibility: eligibility,
      state: "QUEUED",
      fixture_snapshot_id: incoming.common.fixture_snapshot_id,
      fixture_digest: null,
      arm: incoming.model && "arm" in incoming.model ? (incoming.model.arm ?? null) : null,
      pair_id: null,
      scenario_id: scenario?.scenario_id ?? null,
      scenario_version: scenario?.version ?? null,
      action_program_id: incoming.deterministic?.action_program_id ?? null,
      action_program_digest: incoming.deterministic?.action_program_digest ?? null,
      custom_input_digest: customDigest,
      requested_model_id: incoming.model?.model_id ?? null,
      returned_model_id: null,
      terminal_reason: null,
      start_at: utcNow(),
      end_at: null,
      created_at: utcNow(),
      updated_at: utcNow(),
    };
    await this.store.insertRun(run, {
      run_id: runId,
      scenario_id: scenario?.scenario_id ?? null,
      scenario_version: scenario?.version ?? null,
      custom_input_snapshot: customSnapshot,
      custom_input_digest: customDigest,
      consent_policy: consent,
      permitted_actions: permitted,
      structured_criteria: (body.structured_criteria as Record<string, unknown>) ?? null,
      redaction_revision: REDACTION_REVISION,
    });
    await this.store.appendEvent({
      run_id: runId,
      source: runType === "CUSTOM_MISSION" ? "USER_INPUT" : "ATLASLAB_ORCHESTRATOR",
      kind: "RUN_CREATED",
      payload: {
        run_type: runType,
        evidence_eligibility: eligibility,
        custom_input_digest: customDigest,
        configuration_digest: cfgRec.configuration_digest,
      },
    });
    if (body.execute === false) return this.store.getRun(runId) as Promise<RunRecord>;
    return this.execute(runId);
  }

  async execute(runId: string): Promise<RunRecord> {
    let run = await this.requireRun(runId);
    if (TERMINAL_STATES.has(run.state) && run.state !== "QUEUED") return run;
    run = await this.store.updateRun(runId, { state: "RESETTING_FIXTURE" });
    if (this.mockGateway && run.scenario_id === "scn_qm_requote_v1") {
      this.mockGateway.invalidateAfterPrepare = true;
    }
    if (this.mockGateway && run.scenario_id) {
      const scn = this.scenarios.find((s) => s.scenario_id === run.scenario_id);
      if (scn) this.mockGateway.paymentSimulation = scn.payment_simulation;
    }
    const reset = await this.fixtures.reset(run.fixture_snapshot_id);
    run = await this.store.updateRun(runId, { fixture_digest: reset.digest, state: "READY" });
    await this.store.appendEvent({
      run_id: runId,
      source: "ATLASLAB_ORCHESTRATOR",
      kind: "FIXTURE_RESET",
      payload: { digest: reset.digest, fixture_snapshot_id: reset.fixture_snapshot_id },
    });
    run = await this.store.updateRun(runId, { state: "RUNNING" });
    const input = await this.store.getRunInput(runId);
    if (!input) throw new LabError("NOT_FOUND", "run input missing", 404);
    const scn = this.scenarios.find((s) => s.scenario_id === run.scenario_id);
    const wallSeconds = Math.min(
      this.cfg.maxWallSeconds,
      Number(scn?.stopping_rules?.wall_seconds ?? this.cfg.maxWallSeconds) || this.cfg.maxWallSeconds,
    );
    const deadlineMs = Date.now() + wallSeconds * 1000;
    try {
      if (run.run_type === "DETERMINISTIC_SCENARIO") {
        if (!scn?.action_program) throw new LabError("INVALID_PROGRAM", "action program missing");
        const driver = new DeterministicDriver(this.store, this.host);
        const result = await driver.run({
          run,
          program: scn.action_program,
          consent: input.consent_policy,
          permittedActions: input.permitted_actions,
          extraSecrets: this.extraSecrets(),
          deadlineMs,
        });
        run = await this.store.updateRun(runId, { state: "RECONCILING" });
        run = await this.store.updateRun(runId, { state: "EVALUATING" });
        const evaluation = await evaluateRun(this.store, run, result.publicState, scn);
        await persistProof(this.store, run, result.publicState, scn, this.extraSecrets());
        const failed = Boolean(result.failed) || result.terminalCode === "FAILED_UNRESOLVED" || !evaluation.hardGatesPassed;
        run = await this.store.updateRun(runId, {
          state: failed ? "FAILED" : "COMPLETED",
          terminal_reason: result.failed ?? (!evaluation.hardGatesPassed ? "HARD_GATE_FAILED" : result.terminalCode),
          end_at: utcNow(),
        });
      } else {
        if (!this.modelAdapter) throw new LabError("MODEL_UNAVAILABLE", "model adapter not initialized", 409);
        const cfg = await this.store.getConfiguration(run.configuration_id);
        const model = cfg?.driver as ModelDriverConfiguration;
        const loop = new SkillLoop(this.store, this.host, this.modelAdapter);
        const mission = run.run_type === "CUSTOM_MISSION" ? (input.custom_input_snapshot ?? "") : (scn?.user_mission ?? "");
        const result = await loop.run({
          run,
          model,
          consent: input.consent_policy,
          permittedActions: input.permitted_actions,
          mission,
          extraSecrets: this.extraSecrets(),
          deadlineMs,
          scenario: scn,
        });
        run = await this.store.updateRun(runId, { returned_model_id: result.returnedModelId ?? null, state: "EVALUATING" });
        const evaluation = await evaluateRun(this.store, run, result.publicState, scn);
        await persistProof(this.store, run, result.publicState, scn, this.extraSecrets());
        const failed = Boolean(result.failed) || !evaluation.hardGatesPassed;
        run = await this.store.updateRun(runId, {
          state: failed ? "FAILED" : "COMPLETED",
          terminal_reason: result.failed ?? (!evaluation.hardGatesPassed ? "HARD_GATE_FAILED" : result.terminalCode),
          end_at: utcNow(),
        });
      }
    } catch (err) {
      const code = err instanceof LabError ? err.code : "FAILED";
      run = await this.store.updateRun(runId, { state: "FAILED", terminal_reason: code, end_at: utcNow() });
      await this.store.appendEvent({
        run_id: runId,
        source: "ATLASLAB_ORCHESTRATOR",
        kind: "RUN_FAILED",
        payload: { code },
      });
    }
    return run;
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (TERMINAL_STATES.has(run.state)) {
      throw new LabError("CONFLICT", "cannot cancel a terminal run", 409);
    }
    await this.store.appendEvent({
      run_id: runId,
      source: "ATLASLAB_ORCHESTRATOR",
      kind: "CANCEL_REQUESTED",
      payload: { previous_state: run.state },
    });
    return this.store.updateRun(runId, { state: "CANCELLED", terminal_reason: "CANCEL_REQUESTED", end_at: utcNow() });
  }

  async resume(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (TERMINAL_STATES.has(run.state)) return run;
    return this.execute(runId);
  }

  async startPair(body: Record<string, unknown>): Promise<PairResultRecord> {
    const pairingKey = String(body.pairing_key ?? "");
    if (!pairingKey) throw new LabError("INVALID_ARGUMENT", "pairing_key required");

    if (body.control_run_id && body.treatment_run_id && !body.scenario_id) {
      const control = await this.requireRun(String(body.control_run_id));
      const treatment = await this.requireRun(String(body.treatment_run_id));
      const judged = pairRuns({ pairingKey, control, treatment, firstArm: "CONTROL" });
      judged.pair_id = newPairId();
      judged.eligible = false;
      judged.deltas = null;
      judged.exclusion_reason = judged.exclusion_reason ?? "LEGACY_PAIR_LABEL";
      judged.state = "EXCLUDED";
      await this.store.putPair(judged);
      return judged;
    }

    const scenarioId = String(body.scenario_id ?? "");
    const modelId = String(body.model_id ?? "");
    if (!scenarioId || !modelId) {
      throw new LabError("INVALID_ARGUMENT", "pair-first requires pairing_key, scenario_id, and model_id", 400);
    }
    const firstArm: "CONTROL" | "TREATMENT" =
      body.first_arm === "TREATMENT" || body.first_arm === "CONTROL"
        ? body.first_arm
        : Math.random() < 0.5
          ? "CONTROL"
          : "TREATMENT";
    const pairId = newPairId();
    await this.store.putPair({
      pair_id: pairId,
      pairing_key: pairingKey,
      control_run_id: null,
      treatment_run_id: null,
      eligible: false,
      exclusion_reason: null,
      first_arm: firstArm,
      fixture_digest: null,
      deltas: null,
      guardrails: { critical_safety_failure: false },
      state: "PAIR_CREATED",
    });

    const order: Array<"CONTROL" | "TREATMENT"> = firstArm === "CONTROL" ? ["CONTROL", "TREATMENT"] : ["TREATMENT", "CONTROL"];
    const byArm: Partial<Record<"CONTROL" | "TREATMENT", RunRecord>> = {};
    for (const arm of order) {
      const run = await this.startRun({
        run_type: "BENCHMARK_MODEL",
        scenario_id: scenarioId,
        model_id: modelId,
        arm,
        pairing_key: pairingKey,
        fixture_snapshot_id: body.fixture_snapshot_id,
        payment_simulation: body.payment_simulation,
      });
      const stamped = await this.store.updateRun(run.run_id, { pair_id: pairId, arm });
      byArm[arm] = stamped;
    }
    const control = byArm.CONTROL;
    const treatment = byArm.TREATMENT;
    if (!control || !treatment) throw new LabError("INTERNAL", "pair arms missing", 500);
    const controlProj = await this.store.latestProjection(control.run_id);
    const treatmentProj = await this.store.latestProjection(treatment.run_id);
    const judged = pairRuns({
      pairingKey,
      control,
      treatment,
      firstArm,
      controlRevenueMinor: extractRevenueMinor(controlProj?.public_state),
      treatmentRevenueMinor: extractRevenueMinor(treatmentProj?.public_state),
      controlUnknown: Boolean(controlProj?.public_state.outcome_unknown),
      treatmentUnknown: Boolean(treatmentProj?.public_state.outcome_unknown),
    });
    judged.pair_id = pairId;
    judged.state = judged.eligible ? "COMPLETED" : "EXCLUDED";
    await this.store.putPair(judged);
    return judged;
  }

  private parseIncoming(body: Record<string, unknown>): IncomingRunRequest {
    const run_type = body.run_type as IncomingRunRequest["run_type"];
    const extra_fields = Object.keys(body).filter((k) =>
      ["model_id", "token_ceiling", "cost_ceiling_usd_micros", "action_program_id", "custom_input_digest", "arm", "pairing_key", "scenario_id"].includes(k) &&
      ((run_type === "DETERMINISTIC_SCENARIO" && ["model_id", "token_ceiling", "cost_ceiling_usd_micros", "arm", "pairing_key"].includes(k)) ||
        (run_type === "CUSTOM_MISSION" && ["scenario_id", "action_program_id", "arm", "pairing_key"].includes(k)) ||
        (run_type === "BENCHMARK_MODEL" && ["custom_input_digest", "action_program_id"].includes(k))),
    );
    const common = {
      run_type,
      atlas_contract_version: this.cfg.atlasContractVersion,
      evaluator_set_version: this.cfg.evaluatorSetVersion,
      fixture_snapshot_id: String(body.fixture_snapshot_id ?? this.cfg.fixtureSnapshotId),
      host_policy_version: this.cfg.hostPolicyVersion,
      payment_simulation: (body.payment_simulation as never) ?? "NONE",
      wall_deadline_seconds: this.cfg.maxWallSeconds,
      max_attempts_per_step: 3,
    };
    if (run_type === "DETERMINISTIC_SCENARIO") {
      const scn = this.scenarios.find((s) => s.scenario_id === body.scenario_id);
      const deterministic: DeterministicDriverConfiguration = {
        scenario_id: String(body.scenario_id ?? ""),
        scenario_version: scn?.version ?? "1",
        action_program_id: scn?.action_program?.action_program_id ?? "",
        action_program_version: scn?.action_program?.version ?? "1",
        action_program_digest: scn?.action_program?.digest ?? "",
      };
      return { run_type, common: { ...common, payment_simulation: scn?.payment_simulation ?? "NONE" }, deterministic, extra_fields };
    }
    const model: ModelDriverConfiguration = {
      scenario_id: run_type === "BENCHMARK_MODEL" ? String(body.scenario_id ?? "") : undefined,
      scenario_version: "1",
      model_id: String(body.model_id ?? ""),
      system_prompt_version: this.cfg.systemPromptVersion,
      skill_registry_version: this.cfg.skillRegistryVersion,
      temperature: 0,
      max_tokens_per_turn: 1024,
      max_turns: this.cfg.maxTurns,
      max_tool_calls: this.cfg.maxToolCalls,
      token_ceiling: this.cfg.maxTokens,
      cost_ceiling_usd_micros: this.cfg.maxCostUsdMicros,
      buyer_spend_minor: this.cfg.defaultBuyerSpendMinor,
      routing_policy: "same_model_provider_fallback",
      permitted_actions: (body.permitted_actions as PublicMcpTool[]) ?? [],
      arm: body.arm as ModelDriverConfiguration["arm"],
      pairing_key: body.pairing_key as string | undefined,
      custom_input_digest: body.custom_input_digest as string | undefined,
    };
    if (run_type === "CUSTOM_MISSION") {
      delete model.scenario_id;
      delete model.arm;
      delete model.pairing_key;
    }
    return { run_type, common, model, extra_fields };
  }

  private async requireRun(id: string): Promise<RunRecord> {
    const run = await this.store.getRun(id);
    if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
    return run;
  }
}

export { relativeUplift };

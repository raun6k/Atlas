import { contentAddressConfiguration } from "../configuration.js";
import type { AtlasLabConfig } from "../config.js";
import { newPrefixedId, utcNow } from "../ids.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../ids.js";
import { REDACTION_REVISION } from "../redaction.js";
import type { LabStore } from "../db/store.js";
import { newRunId } from "../db/store.js";
import { DeterministicDriver } from "../driver/deterministic.js";
import { applyResultToState, persistProjection } from "../driver/projector.js";
import type { HostBoundary } from "../host/boundary.js";
import type { FixtureResetClient } from "../fixtures/reset-client.js";
import { requireMatchingDigest } from "../fixtures/reset-client.js";
import { LabError, type ActionProgram, type ConsentPolicy, type RunRecord } from "../types.js";
import { suiteCases, SUITE_PERMITTED, type SuiteCase } from "./cases.js";
import { evaluateCase, summarizeSuite, type CaseEval, type ToolTrace } from "./oracle.js";
import { rawMcpCall } from "./probes.js";
import { wrapArtifact } from "../reporter/provenance.js";
import { BANANA_SKU, DEFAULT_LOCATION_ID, loadFixtureWorld, SUITE_PROGRAM_ID, SUITE_SCENARIO_ID } from "./world.js";

const CONSENT: ConsentPolicy = {
  max_amount_minor: 250000,
  currency: "INR",
  capability_id: "pcap_razorpay_test",
};

export async function runDeterministicSuite(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
}): Promise<{ run: RunRecord; report: ReturnType<typeof summarizeSuite> }> {
  if (opts.cfg.mockMcp) {
    throw new LabError("ATLAS_REQUIRED", "deterministic suite eval requires real Atlas MCP (ATLASLAB_MOCK_MCP=0)", 409);
  }
  const world = loadFixtureWorld();
  const cfgRec = contentAddressConfiguration(
    {
      run_type: "DETERMINISTIC_SUITE",
      atlas_contract_version: opts.cfg.atlasContractVersion,
      evaluator_set_version: "eval_v2_deterministic_suite",
      fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
      host_policy_version: opts.cfg.hostPolicyVersion,
      payment_simulation: "NONE",
      wall_deadline_seconds: opts.cfg.maxWallSeconds,
      max_attempts_per_step: 3,
    },
    {
      scenario_id: SUITE_SCENARIO_ID,
      scenario_version: "1",
      action_program_id: SUITE_PROGRAM_ID,
      action_program_version: "1",
      action_program_digest: sha256Hex(canonicalize({ suite: "qm_v1", fee_spec: "eval_fees_v1" })),
    },
  );
  await opts.store.putConfiguration(cfgRec);
  const runId = newRunId();
  const run: RunRecord = {
    run_id: runId,
    run_type: "DETERMINISTIC_SUITE",
    configuration_id: cfgRec.configuration_id,
    configuration_digest: cfgRec.configuration_digest,
    evidence_eligibility: "CONTRACT_EVIDENCE_ONLY",
    state: "QUEUED",
    fixture_snapshot_id: opts.cfg.fixtureSnapshotId,
    fixture_digest: world.digest,
    arm: null,
    pair_id: null,
    scenario_id: SUITE_SCENARIO_ID,
    scenario_version: "1",
    action_program_id: SUITE_PROGRAM_ID,
    action_program_digest: cfgRec.driver && "action_program_digest" in cfgRec.driver ? cfgRec.driver.action_program_digest : null,
    custom_input_digest: null,
    requested_model_id: null,
    returned_model_id: null,
    terminal_reason: null,
    start_at: utcNow(),
    end_at: null,
    created_at: utcNow(),
    updated_at: utcNow(),
  };
  await opts.store.insertRun(run, {
    run_id: runId,
    scenario_id: SUITE_SCENARIO_ID,
    scenario_version: "1",
    custom_input_snapshot: null,
    custom_input_digest: null,
    consent_policy: CONSENT,
    permitted_actions: [...SUITE_PERMITTED],
    structured_criteria: { suite: true, oracle_fee_spec_version: "eval_fees_v1" },
    redaction_revision: REDACTION_REVISION,
  });
  await opts.store.appendEvent({
    run_id: runId,
    source: "ATLASLAB_ORCHESTRATOR",
    kind: "SUITE_STARTED",
    payload: { cases: suiteCases().map((c) => c.case_id) },
  });

  const evals: CaseEval[] = [];
  let lastDigest = world.digest;
  try {
    for (const cse of suiteCases()) {
      await opts.store.appendEvent({
        run_id: runId,
        source: "ATLASLAB_ORCHESTRATOR",
        kind: "CASE_BEGIN",
        payload: { case_id: cse.case_id, dimension: cse.dimension },
      });
      const before = (await opts.store.listToolExchanges(runId)).length;
      try {
        const reset = await opts.fixtures.reset(opts.cfg.fixtureSnapshotId);
        requireMatchingDigest(world.digest, reset);
        lastDigest = reset.digest;
        const ev = await executeCase({ ...opts, run: { ...run, run_id: runId }, world, cse, exchangeOffset: before });
        evals.push(ev);
      } catch (err) {
        const code = err instanceof LabError ? err.code : "FAILED";
        if (code === "FIXTURE_RESET_FAILED" || code === "FIXTURE_DIGEST_MISMATCH" || code === "TRANSPORT_TIMEOUT" || code === "MCP_ERROR") {
          evals.push({
            case_id: cse.case_id,
            dimension: cse.dimension,
            result: "INFRASTRUCTURE",
            reason: code,
            checks: [],
          });
          continue;
        }
        evals.push({
          case_id: cse.case_id,
          dimension: cse.dimension,
          result: "FAIL",
          reason: code,
          checks: [],
        });
      }
      await opts.store.appendEvent({
        run_id: runId,
        source: "ATLASLAB_EVALUATOR",
        kind: "CASE_END",
        payload: { case_id: cse.case_id, result: evals.at(-1)?.result },
      });
    }
  } catch (err) {
    const code = err instanceof LabError ? err.code : "INFRASTRUCTURE";
    const report = summarizeSuite(
      [
        ...evals,
        ...suiteCases()
          .filter((c) => !evals.some((e) => e.case_id === c.case_id))
          .map((c) => ({
            case_id: c.case_id,
            dimension: c.dimension,
            result: "INFRASTRUCTURE" as const,
            reason: code,
            checks: [],
          })),
      ],
      world,
      lastDigest,
    );
    await persistReport(opts.store, runId, report);
    const failed = await opts.store.updateRun(runId, { state: "FAILED", terminal_reason: code, end_at: utcNow(), fixture_digest: lastDigest });
    return { run: failed, report };
  }

  const report = summarizeSuite(evals, world, lastDigest);
  await persistReport(opts.store, runId, report);
  const failed = evals.some((e) => e.result === "FAIL");
  const updated = await opts.store.updateRun(runId, {
    state: failed ? "FAILED" : "COMPLETED",
    terminal_reason: failed ? "SUITE_CASE_FAILED" : "SUITE_COMPLETED",
    end_at: utcNow(),
    fixture_digest: lastDigest,
  });
  return { run: updated, report };
}

async function executeCase(opts: {
  cfg: AtlasLabConfig;
  store: LabStore;
  host: HostBoundary;
  fixtures: FixtureResetClient;
  extraSecrets: string[];
  run: RunRecord;
  world: ReturnType<typeof loadFixtureWorld>;
  cse: SuiteCase;
  exchangeOffset: number;
}): Promise<CaseEval> {
  const consent: ConsentPolicy = {
    ...CONSENT,
    max_amount_minor: opts.cse.consentMaxMinor ?? CONSENT.max_amount_minor,
  };

  if (opts.cse.skipReason) {
    return evaluateCase({
      case_id: opts.cse.case_id,
      dimension: opts.cse.dimension,
      world: opts.world,
      traces: [],
      skipReason: opts.cse.skipReason,
    });
  }

  if (opts.cse.kind === "unsigned_mutation") {
    const trace = await rawMcpCall({
      mcpUrl: opts.cfg.mcpUrl,
      hostBearer: opts.cfg.hostBearer,
      tool: "add_cart_item",
      arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
    });
    return evaluateCase({ case_id: opts.cse.case_id, dimension: opts.cse.dimension, world: opts.world, traces: [trace] });
  }
  if (opts.cse.kind === "unknown_tool") {
    const trace = await rawMcpCall({
      mcpUrl: opts.cfg.mcpUrl,
      hostBearer: opts.cfg.hostBearer,
      tool: "not_a_public_tool",
      arguments: {},
    });
    return evaluateCase({ case_id: opts.cse.case_id, dimension: opts.cse.dimension, world: opts.world, traces: [trace] });
  }

  if (!opts.cse.program) {
    return evaluateCase({
      case_id: opts.cse.case_id,
      dimension: opts.cse.dimension,
      world: opts.world,
      traces: [],
      skipReason: "NO_PROGRAM",
    });
  }

  const cases = suiteCases();
  const control = cases.find((c) => c.case_id === "commercial_control");
  const treatment = cases.find((c) => c.case_id === "commercial_treatment");
  if ((control?.strategyAllowlist ?? []).join() === (treatment?.strategyAllowlist ?? []).join()) {
    throw new LabError("CONFIGURATION_ERROR", "scripted control and treatment policies are identical", 409);
  }

  const driver = new DeterministicDriver(opts.store, opts.host);
  const result = await driver.run({
    run: { ...opts.run, arm: opts.cse.arm ?? opts.run.arm },
    program: namespaceProgram(opts.cse.program, opts.cse.case_id),
    consent,
    permittedActions: [...SUITE_PERMITTED],
    extraSecrets: opts.extraSecrets,
    deadlineMs: Date.now() + 120_000,
    sessionPolicy: {
      strategyAllowlist: opts.cse.strategyAllowlist ?? [],
    },
  });

  if (opts.cse.kind === "payment_fixture" && opts.cse.paymentOutcome) {
    const sessionId = result.publicState.session_id;
    if (!sessionId) {
      return evaluateCase({
        case_id: opts.cse.case_id,
        dimension: opts.cse.dimension,
        world: opts.world,
        traces: await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset),
        infrastructure: true,
      });
    }
    try {
      const ev = await opts.fixtures.paymentOutcome?.(sessionId, opts.cse.paymentOutcome);
      if (!ev) {
        return evaluateCase({
          case_id: opts.cse.case_id,
          dimension: opts.cse.dimension,
          world: opts.world,
          traces: await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset),
          infrastructure: true,
        });
      }
      const order = await opts.host.invoke({
        run: { ...opts.run, arm: opts.cse.arm ?? opts.run.arm },
        tool: "get_order",
        arguments: {
          ...(result.publicState.session_id ? { session_id: result.publicState.session_id } : {}),
          ...(result.publicState.merchant_order_id ? { merchant_order_id: result.publicState.merchant_order_id } : {}),
        },
        proposedBy: "DETERMINISTIC_DRIVER",
        permittedActions: [...SUITE_PERMITTED],
        consent,
        publicState: result.publicState,
        extraSecrets: opts.extraSecrets,
        sessionPolicy: { strategyAllowlist: opts.cse.strategyAllowlist ?? [] },
      });
      await persistProjection(opts.store, opts.run.run_id, applyResultToState(result.publicState, order));
      const traces = await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset);
      traces.push({
        tool: "get_order",
        arguments: {},
        result_code: order.resultCode,
        payload: { ...order.payload, ...ev },
      });
      return evaluateCase({
        case_id: opts.cse.case_id,
        dimension: opts.cse.dimension,
        world: opts.world,
        traces,
      });
    } catch (err) {
      const code = err instanceof LabError ? err.code : "INFRASTRUCTURE";
      return evaluateCase({
        case_id: opts.cse.case_id,
        dimension: opts.cse.dimension,
        world: opts.world,
        traces: await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset),
        infrastructure: true,
      });
    }
  }

  if (opts.cse.needsInvalidate) {
    const invalidated = await opts.fixtures.invalidateInventory?.(DEFAULT_LOCATION_ID, BANANA_SKU);
    if (!invalidated) {
      return evaluateCase({
        case_id: opts.cse.case_id,
        dimension: opts.cse.dimension,
        world: opts.world,
        traces: await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset),
        skipReason: "HOOK_UNAVAILABLE",
      });
    }
    const proj = await opts.store.latestProjection(opts.run.run_id);
    if (proj) {
      try {
        const complete = await opts.host.invoke({
          run: opts.run,
          tool: "complete_checkout",
          arguments: {},
          proposedBy: "DETERMINISTIC_DRIVER",
          permittedActions: [...SUITE_PERMITTED],
          consent,
          publicState: proj.public_state,
          extraSecrets: opts.extraSecrets,
        });
        await persistProjection(opts.store, opts.run.run_id, applyResultToState(proj.public_state, complete));
      } catch (err) {
        const code = err instanceof LabError ? err.code : "FAILED";
        return evaluateCase({
          case_id: opts.cse.case_id,
          dimension: opts.cse.dimension,
          world: opts.world,
          traces: [
            ...(await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset)),
            { tool: "complete_checkout", arguments: {}, result_code: code, payload: {} },
          ],
        });
      }
    }
  }

  if (opts.cse.replayComplete) {
    const exchanges = await opts.store.listToolExchanges(opts.run.run_id);
    const last = [...exchanges].reverse().find((e) => e.tool_name === "complete_checkout");
    const proj = await opts.store.latestProjection(opts.run.run_id);
    if (last?.idempotency_key && proj) {
      try {
        const replay = await opts.host.invoke({
          run: opts.run,
          tool: "complete_checkout",
          arguments: last.proposed_arguments,
          proposedBy: "DETERMINISTIC_DRIVER",
          idempotencyKey: last.idempotency_key,
          permittedActions: [...SUITE_PERMITTED],
          consent,
          publicState: proj.public_state,
          extraSecrets: opts.extraSecrets,
        });
        const next = applyResultToState(proj.public_state, replay);
        await persistProjection(opts.store, opts.run.run_id, next);
      } catch {
        // replay may reject; oracle still sees two exchanges if the second was recorded
      }
    }
  }

  if (result.failed === "SIGNER_REJECTED") {
    const traces = await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset);
    traces.push({ tool: "complete_checkout", arguments: {}, result_code: "SIGNER_REJECTED", payload: {} });
    return evaluateCase({
      case_id: opts.cse.case_id,
      dimension: opts.cse.dimension,
      world: opts.world,
      traces,
      declaredPromoIds: opts.cse.declaredPromoIds,
    });
  }

  const traces = await tracesSince(opts.store, opts.run.run_id, opts.exchangeOffset);
  return evaluateCase({
    case_id: opts.cse.case_id,
    dimension: opts.cse.dimension,
    world: opts.world,
    traces,
    declaredPromoIds: opts.cse.declaredPromoIds,
  });
}

function namespaceProgram(program: ActionProgram, prefix: string): ActionProgram {
  const id = (stepId: string) =>
    stepId === "TERMINAL" || stepId === "FAIL" || stepId === "default" ? stepId : `${prefix}_${stepId}`;
  return {
    ...program,
    action_program_id: `${prefix}_${program.action_program_id}`,
    entry_step_id: id(program.entry_step_id),
    steps: program.steps.map((st) => ({
      ...st,
      step_id: id(st.step_id),
      next: Object.fromEntries(
        Object.entries(st.next).map(([k, v]) => [k, typeof v === "string" ? id(v) : v]),
      ) as ActionProgram["steps"][number]["next"],
    })),
  };
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

async function persistReport(store: LabStore, runId: string, report: ReturnType<typeof summarizeSuite>): Promise<void> {
  const wrapped = wrapArtifact(report, {
    evaluator_version: "eval_v2_deterministic_suite",
    run_ids: [runId],
    evidence_quality: "confirmed",
    evidence_level: "contract",
  });
  const body = JSON.stringify({ ...report, provenance: wrapped.provenance });
  await store.putArtifact({
    artifact_id: newPrefixedId("art"),
    report_id: `suite_${runId}`,
    kind: "deterministic_eval.json",
    content_digest: wrapped.provenance.content_digest,
    local_path: null,
    body,
  });
}

export async function loadSuiteReport(store: LabStore, runId: string): Promise<ReturnType<typeof summarizeSuite> | undefined> {
  const arts = await store.getArtifactsByReport(`suite_${runId}`);
  const art = arts.find((a) => a.kind === "deterministic_eval.json");
  if (!art?.body) return undefined;
  return JSON.parse(art.body) as ReturnType<typeof summarizeSuite>;
}

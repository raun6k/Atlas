import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { utcNow } from "../ids.js";
import type {
  AgentTurnRecord,
  ArtifactRecord,
  DriverStepRecord,
  EvaluationRecord,
  GradeRecord,
  ModelInvocationRecord,
  PairResultRecord,
  PaymentAssuranceProjection,
  RunConfigurationRecord,
  RunEventRecord,
  RunInputRecord,
  RunProof,
  RunRecord,
  StateProjectionRecord,
  ToolExchangeRecord,
  TrajectoryStep,
} from "../types.js";
import { LabError } from "../types.js";
import { newEventId, type LabStore } from "./store.js";

export class PostgresStore implements LabStore {
  constructor(private readonly pool: pg.Pool) {}

  async putConfiguration(cfg: RunConfigurationRecord): Promise<void> {
    const r = await this.pool.query(
      `INSERT INTO run_configurations (
        configuration_id, configuration_digest, run_type, atlas_contract_version, evaluator_set_version,
        fixture_snapshot_id, host_policy_version, payment_simulation, common_json, driver_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (configuration_digest) DO UPDATE SET configuration_digest = EXCLUDED.configuration_digest
      RETURNING configuration_id`,
      [
        cfg.configuration_id,
        cfg.configuration_digest,
        cfg.run_type,
        cfg.common.atlas_contract_version,
        cfg.common.evaluator_set_version,
        cfg.common.fixture_snapshot_id,
        cfg.common.host_policy_version,
        cfg.common.payment_simulation,
        cfg.common,
        cfg.driver,
      ],
    );
    const storedId = r.rows[0]?.configuration_id as string | undefined;
    if (storedId) cfg.configuration_id = storedId;
  }

  async getConfiguration(id: string) {
    const r = await this.pool.query(`SELECT * FROM run_configurations WHERE configuration_id=$1`, [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      configuration_id: row.configuration_id,
      configuration_digest: row.configuration_digest,
      run_type: row.run_type,
      common: row.common_json,
      driver: row.driver_json,
    };
  }

  async listConfigurations() {
    const r = await this.pool.query(`SELECT configuration_id FROM run_configurations`);
    const out = [];
    for (const row of r.rows) {
      const c = await this.getConfiguration(row.configuration_id);
      if (c) out.push(c);
    }
    return out;
  }

  async insertRun(run: RunRecord, input: RunInputRecord): Promise<void> {
    await this.pool.query("BEGIN");
    try {
      await this.pool.query(
        `INSERT INTO runs (
          run_id, run_type, configuration_id, configuration_digest, evidence_eligibility, state,
          fixture_snapshot_id, fixture_digest, arm, pair_id, scenario_id, scenario_version,
          action_program_id, action_program_digest, custom_input_digest, requested_model_id,
          returned_model_id, terminal_reason, start_at, end_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          run.run_id, run.run_type, run.configuration_id, run.configuration_digest, run.evidence_eligibility, run.state,
          run.fixture_snapshot_id, run.fixture_digest, run.arm, run.pair_id, run.scenario_id, run.scenario_version,
          run.action_program_id, run.action_program_digest, run.custom_input_digest, run.requested_model_id,
          run.returned_model_id, run.terminal_reason, run.start_at, run.end_at, run.created_at, run.updated_at,
        ],
      );
      await this.pool.query(
        `INSERT INTO run_inputs (
          run_id, scenario_id, scenario_version, custom_input_snapshot, custom_input_digest,
          consent_policy_json, permitted_actions, structured_criteria, redaction_revision
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.run_id, input.scenario_id, input.scenario_version, input.custom_input_snapshot, input.custom_input_digest,
          input.consent_policy, JSON.stringify(input.permitted_actions), input.structured_criteria, input.redaction_revision,
        ],
      );
      await this.pool.query("COMMIT");
    } catch (e) {
      await this.pool.query("ROLLBACK");
      throw e;
    }
  }

  async getRun(id: string) {
    const r = await this.pool.query(`SELECT * FROM runs WHERE run_id=$1`, [id]);
    return r.rows[0] as RunRecord | undefined;
  }
  async listRuns() {
    const r = await this.pool.query(`SELECT * FROM runs ORDER BY created_at`);
    return r.rows as RunRecord[];
  }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = await this.getRun(id);
    if (!current) throw new LabError("NOT_FOUND", "run not found", 404);
    const next = { ...current, ...patch, updated_at: utcNow() };
    await this.pool.query(
      `UPDATE runs SET
        evidence_eligibility=$2, state=$3, fixture_digest=$4, arm=$5, pair_id=$6,
        returned_model_id=$7, terminal_reason=$8, start_at=$9, end_at=$10, updated_at=$11
       WHERE run_id=$1`,
      [id, next.evidence_eligibility, next.state, next.fixture_digest, next.arm, next.pair_id, next.returned_model_id, next.terminal_reason, next.start_at, next.end_at, next.updated_at],
    );
    return next;
  }
  async getRunInput(runId: string) {
    const r = await this.pool.query(`SELECT * FROM run_inputs WHERE run_id=$1`, [runId]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      run_id: row.run_id,
      scenario_id: row.scenario_id,
      scenario_version: row.scenario_version,
      custom_input_snapshot: row.custom_input_snapshot,
      custom_input_digest: row.custom_input_digest,
      consent_policy: row.consent_policy_json,
      permitted_actions: row.permitted_actions,
      structured_criteria: row.structured_criteria,
      redaction_revision: row.redaction_revision,
    } as RunInputRecord;
  }
  async appendEvent(event: Omit<RunEventRecord, "event_id" | "record_sequence" | "occurred_at"> & Partial<Pick<RunEventRecord, "event_id" | "occurred_at">>): Promise<RunEventRecord> {
    const seq = await this.pool.query(`SELECT COALESCE(MAX(record_sequence),0)+1 AS n FROM run_events WHERE run_id=$1`, [event.run_id]);
    const record: RunEventRecord = {
      event_id: event.event_id ?? newEventId(),
      run_id: event.run_id,
      record_sequence: Number(seq.rows[0].n),
      source: event.source,
      kind: event.kind,
      occurred_at: event.occurred_at ?? utcNow(),
      payload: event.payload,
    };
    await this.pool.query(
      `INSERT INTO run_events (event_id, run_id, record_sequence, source, kind, occurred_at, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.event_id, record.run_id, record.record_sequence, record.source, record.kind, record.occurred_at, record.payload],
    );
    return record;
  }
  async listEvents(runId: string, afterSequence = 0) {
    const r = await this.pool.query(`SELECT * FROM run_events WHERE run_id=$1 AND record_sequence>$2 ORDER BY record_sequence`, [runId, afterSequence]);
    return r.rows.map((row) => ({
      event_id: row.event_id,
      run_id: row.run_id,
      record_sequence: Number(row.record_sequence),
      source: row.source,
      kind: row.kind,
      occurred_at: row.occurred_at,
      payload: row.payload_json,
    }));
  }
  async insertDriverStep(step: DriverStepRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO driver_steps (driver_step_id, run_id, step_id, attempt, action_program_id, public_precondition, selected_branch, typed_action, result_code, next_step_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [step.driver_step_id, step.run_id, step.step_id, step.attempt, step.action_program_id, step.public_precondition, step.selected_branch, step.typed_action, step.result_code, step.next_step_id],
    );
  }
  async listDriverSteps(runId: string) {
    const r = await this.pool.query(`SELECT * FROM driver_steps WHERE run_id=$1`, [runId]);
    return r.rows as DriverStepRecord[];
  }
  async insertAgentTurn(turn: AgentTurnRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_turns (agent_turn_id, run_id, turn_number, snapshot_digest, selected_skill, invocation_id, structured_action, visible_decision_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [turn.agent_turn_id, turn.run_id, turn.turn_number, turn.snapshot_digest, turn.selected_skill, turn.invocation_id, turn.structured_action, turn.visible_decision_summary],
    );
  }
  async insertToolExchange(ex: ToolExchangeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_exchanges (tool_exchange_id, run_id, tool_name, canonical_argument_digest, idempotency_key, request_status, result_status, latency_ms, atlas_ids, proposed_arguments, host_enriched_request, atlas_response, returned_to_driver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ex.tool_exchange_id, ex.run_id, ex.tool_name, ex.canonical_argument_digest, ex.idempotency_key, ex.request_status, ex.result_status, ex.latency_ms, ex.atlas_ids, ex.proposed_arguments, ex.host_enriched_request, ex.atlas_response, ex.returned_to_driver],
    );
  }
  async listToolExchanges(runId: string) {
    const r = await this.pool.query(`SELECT * FROM tool_exchanges WHERE run_id=$1`, [runId]);
    return r.rows as ToolExchangeRecord[];
  }
  async insertProjection(p: StateProjectionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO state_projections (projection_id, run_id, after_exchange_id, public_state) VALUES ($1,$2,$3,$4)`,
      [p.projection_id, p.run_id, p.after_exchange_id, p.public_state],
    );
  }
  async latestProjection(runId: string) {
    const r = await this.pool.query(`SELECT * FROM state_projections WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1`, [runId]);
    const row = r.rows[0];
    if (!row) return undefined;
    return { projection_id: row.projection_id, run_id: row.run_id, after_exchange_id: row.after_exchange_id, public_state: row.public_state };
  }
  async insertModelInvocation(inv: ModelInvocationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_invocations (invocation_id, run_id, requested_model_id, returned_model_id, configuration_json, usage_json, cost_usd_micros, latency_ms, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [inv.invocation_id, inv.run_id, inv.requested_model_id, inv.returned_model_id, inv.configuration, inv.usage, inv.cost_usd_micros, inv.latency_ms, inv.outcome],
    );
  }
  async listModelInvocations(runId: string) {
    const r = await this.pool.query(`SELECT * FROM model_invocations WHERE run_id=$1`, [runId]);
    return r.rows as ModelInvocationRecord[];
  }
  async insertEvaluation(ev: EvaluationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO evaluations (evaluation_id, run_id, evaluator_id, evaluator_version, assertion_id, result, severity, evidence_refs, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ev.evaluation_id, ev.run_id, ev.evaluator_id, ev.evaluator_version, ev.assertion_id, ev.result, ev.severity, JSON.stringify(ev.evidence_refs), ev.detail],
    );
  }
  async listEvaluations(runId: string) {
    const r = await this.pool.query(`SELECT * FROM evaluations WHERE run_id=$1`, [runId]);
    return r.rows as EvaluationRecord[];
  }
  async upsertGrade(g: GradeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO grades (grade_id, run_id, dimension, result, hard_gate, detail_json) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, dimension) DO UPDATE SET result=$4, hard_gate=$5, detail_json=$6`,
      [g.grade_id, g.run_id, g.dimension, g.result, g.hard_gate, g.detail],
    );
  }
  async listGrades(runId: string) {
    const r = await this.pool.query(`SELECT * FROM grades WHERE run_id=$1`, [runId]);
    return r.rows as GradeRecord[];
  }
  async putPair(pair: PairResultRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO pair_results (pair_id, pairing_key, control_run_id, treatment_run_id, eligible, exclusion_reason, first_arm, fixture_digest, deltas_json, guardrails_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (pair_id) DO UPDATE SET
         control_run_id=$3, treatment_run_id=$4, eligible=$5, exclusion_reason=$6,
         first_arm=$7, fixture_digest=$8, deltas_json=$9, guardrails_json=$10, updated_at=now()`,
      [pair.pair_id, pair.pairing_key, pair.control_run_id, pair.treatment_run_id, pair.eligible, pair.exclusion_reason, pair.first_arm, pair.fixture_digest, pair.deltas, pair.guardrails],
    );
  }
  async getPair(id: string) {
    const r = await this.pool.query(`SELECT * FROM pair_results WHERE pair_id=$1`, [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      pair_id: row.pair_id,
      pairing_key: row.pairing_key,
      control_run_id: row.control_run_id,
      treatment_run_id: row.treatment_run_id,
      eligible: row.eligible,
      exclusion_reason: row.exclusion_reason,
      first_arm: row.first_arm,
      fixture_digest: row.fixture_digest,
      deltas: row.deltas_json,
      guardrails: row.guardrails_json,
    };
  }
  async listPairs() {
    const r = await this.pool.query(`SELECT pair_id FROM pair_results`);
    const out = [];
    for (const row of r.rows) {
      const p = await this.getPair(row.pair_id);
      if (p) out.push(p);
    }
    return out;
  }
  async putArtifact(a: ArtifactRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts (artifact_id, report_id, kind, content_digest, local_path, body) VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.artifact_id, a.report_id, a.kind, a.content_digest, a.local_path, a.body],
    );
  }
  async getArtifactsByReport(reportId: string) {
    const r = await this.pool.query(`SELECT * FROM artifacts WHERE report_id=$1`, [reportId]);
    return r.rows as ArtifactRecord[];
  }
  async putRunProof(runId: string, proof: RunProof, trajectory: TrajectoryStep[], assurance: PaymentAssuranceProjection): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_proofs (run_id, proof_json, trajectory_json, payment_assurance_json)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (run_id) DO UPDATE SET proof_json=$2, trajectory_json=$3, payment_assurance_json=$4, computed_at=now()`,
      [runId, proof, trajectory, assurance],
    );
  }
  async getRunProof(runId: string) {
    const r = await this.pool.query(`SELECT proof_json, trajectory_json, payment_assurance_json FROM run_proofs WHERE run_id=$1`, [runId]);
    const row = r.rows[0];
    if (!row) return undefined;
    return { proof: row.proof_json as RunProof, trajectory: row.trajectory_json as TrajectoryStep[], assurance: row.payment_assurance_json as PaymentAssuranceProjection };
  }
  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }
  async migrationVersion() {
    const r = await this.pool.query(`SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1`);
    return (r.rows[0]?.version as string | undefined) ?? null;
  }
}

const _here = dirname(fileURLToPath(import.meta.url));
export function listedMigrationFiles(): string[] {
  try {
    return readdirSync(join(_here, "../../../db/atlaslab/migrations")).filter((f) => f.endsWith(".sql"));
  } catch {
    return [];
  }
}

export function readMigrationSql(name: string): string {
  return readFileSync(join(_here, "../../../db/atlaslab/migrations", name), "utf8");
}

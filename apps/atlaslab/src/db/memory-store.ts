import { utcNow } from "../ids.js";
import type {
  AgentTurnRecord,
  ArtifactRecord,
  ChildSessionRecord,
  DriverStepRecord,
  EvalSittingRecord,
  EvaluationRecord,
  FixtureLeaseRecord,
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

export class MemoryStore implements LabStore {
  configurations = new Map<string, RunConfigurationRecord>();
  runs = new Map<string, RunRecord>();
  inputs = new Map<string, RunInputRecord>();
  events = new Map<string, RunEventRecord[]>();
  driverSteps = new Map<string, DriverStepRecord[]>();
  agentTurns = new Map<string, AgentTurnRecord[]>();
  exchanges = new Map<string, ToolExchangeRecord[]>();
  projections = new Map<string, StateProjectionRecord[]>();
  invocations = new Map<string, ModelInvocationRecord[]>();
  evaluations = new Map<string, EvaluationRecord[]>();
  grades = new Map<string, GradeRecord[]>();
  pairs = new Map<string, PairResultRecord>();
  artifacts: ArtifactRecord[] = [];
  proofs = new Map<string, { proof: RunProof; trajectory: TrajectoryStep[]; assurance: PaymentAssuranceProjection }>();
  sittings = new Map<string, EvalSittingRecord>();
  children = new Map<string, ChildSessionRecord>();
  leases = new Map<string, FixtureLeaseRecord>();
  ready = true;
  version: string | null = "0006_release_repair";

  async putConfiguration(cfg: RunConfigurationRecord): Promise<void> {
    this.configurations.set(cfg.configuration_id, cfg);
  }
  async getConfiguration(id: string) {
    return this.configurations.get(id);
  }
  async listConfigurations() {
    return [...this.configurations.values()];
  }
  async insertRun(run: RunRecord, input: RunInputRecord): Promise<void> {
    this.assertVariant(run);
    this.runs.set(run.run_id, run);
    this.inputs.set(run.run_id, input);
    this.events.set(run.run_id, []);
  }
  async getRun(id: string) {
    return this.runs.get(id);
  }
  async listRuns() {
    return [...this.runs.values()];
  }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = this.runs.get(id);
    if (!current) throw new LabError("NOT_FOUND", "run not found", 404);
    const next = { ...current, ...patch, updated_at: utcNow() };
    this.assertVariant(next);
    this.runs.set(id, next);
    return next;
  }
  async getRunInput(runId: string) {
    return this.inputs.get(runId);
  }
  async appendEvent(event: Omit<RunEventRecord, "event_id" | "record_sequence" | "occurred_at"> & Partial<Pick<RunEventRecord, "event_id" | "occurred_at">>): Promise<RunEventRecord> {
    const list = this.events.get(event.run_id) ?? [];
    const record: RunEventRecord = {
      event_id: event.event_id ?? newEventId(),
      run_id: event.run_id,
      record_sequence: list.length + 1,
      source: event.source,
      kind: event.kind,
      occurred_at: event.occurred_at ?? utcNow(),
      payload: event.payload,
    };
    list.push(record);
    this.events.set(event.run_id, list);
    return record;
  }
  async listEvents(runId: string, afterSequence = 0) {
    return (this.events.get(runId) ?? []).filter((e) => e.record_sequence > afterSequence);
  }
  async insertDriverStep(step: DriverStepRecord): Promise<void> {
    this.assertChild(step.run_id, "driver_steps");
    const list = this.driverSteps.get(step.run_id) ?? [];
    if (list.some((s) => s.step_id === step.step_id && s.attempt === step.attempt)) {
      throw new LabError("CONFLICT", "duplicate driver step attempt");
    }
    list.push(step);
    this.driverSteps.set(step.run_id, list);
  }
  async listDriverSteps(runId: string) {
    return this.driverSteps.get(runId) ?? [];
  }
  async insertAgentTurn(turn: AgentTurnRecord): Promise<void> {
    this.assertChild(turn.run_id, "agent_turns");
    const list = this.agentTurns.get(turn.run_id) ?? [];
    list.push(turn);
    this.agentTurns.set(turn.run_id, list);
  }
  async maxAgentTurnNumber(runId: string): Promise<number> {
    const list = this.agentTurns.get(runId) ?? [];
    return list.reduce((max, t) => Math.max(max, t.turn_number), 0);
  }
  async insertToolExchange(ex: ToolExchangeRecord): Promise<void> {
    const list = this.exchanges.get(ex.run_id) ?? [];
    list.push(ex);
    this.exchanges.set(ex.run_id, list);
  }
  async listToolExchanges(runId: string) {
    return this.exchanges.get(runId) ?? [];
  }
  async insertProjection(p: StateProjectionRecord): Promise<void> {
    const list = this.projections.get(p.run_id) ?? [];
    list.push(p);
    this.projections.set(p.run_id, list);
  }
  async latestProjection(runId: string) {
    const list = this.projections.get(runId) ?? [];
    return list[list.length - 1];
  }
  async insertModelInvocation(inv: ModelInvocationRecord): Promise<void> {
    this.assertChild(inv.run_id, "model_invocations");
    const list = this.invocations.get(inv.run_id) ?? [];
    list.push(inv);
    this.invocations.set(inv.run_id, list);
  }
  async listModelInvocations(runId: string) {
    return this.invocations.get(runId) ?? [];
  }
  async insertEvaluation(ev: EvaluationRecord): Promise<void> {
    const list = this.evaluations.get(ev.run_id) ?? [];
    list.push(ev);
    this.evaluations.set(ev.run_id, list);
  }
  async listEvaluations(runId: string) {
    return this.evaluations.get(runId) ?? [];
  }
  async upsertGrade(g: GradeRecord): Promise<void> {
    const list = (this.grades.get(g.run_id) ?? []).filter((x) => x.dimension !== g.dimension);
    list.push(g);
    this.grades.set(g.run_id, list);
  }
  async listGrades(runId: string) {
    return this.grades.get(runId) ?? [];
  }
  async putPair(pair: PairResultRecord): Promise<void> {
    this.pairs.set(pair.pair_id, pair);
  }
  async getPair(id: string) {
    return this.pairs.get(id);
  }
  async listPairs() {
    return [...this.pairs.values()];
  }
  async putArtifact(a: ArtifactRecord): Promise<void> {
    this.artifacts.push(a);
  }
  async getArtifactsByReport(reportId: string) {
    return this.artifacts.filter((a) => a.report_id === reportId);
  }
  async putRunProof(runId: string, proof: RunProof, trajectory: TrajectoryStep[], assurance: PaymentAssuranceProjection): Promise<void> {
    this.proofs.set(runId, { proof, trajectory, assurance });
  }
  async getRunProof(runId: string) {
    return this.proofs.get(runId);
  }
  async putSitting(s: EvalSittingRecord): Promise<void> {
    this.sittings.set(s.evaluation_id, s);
  }
  async getSitting(id: string) {
    return this.sittings.get(id);
  }
  async updateSitting(id: string, patch: Partial<EvalSittingRecord>): Promise<EvalSittingRecord> {
    const current = this.sittings.get(id);
    if (!current) throw new LabError("NOT_FOUND", "evaluation not found", 404);
    if (current.state === "CANCELLED" && patch.state && patch.state !== "CANCELLED") {
      return current;
    }
    const next = { ...current, ...patch, updated_at: utcNow() };
    this.sittings.set(id, next);
    return next;
  }
  async listSittings() {
    return [...this.sittings.values()];
  }
  async putChildSession(c: ChildSessionRecord): Promise<void> {
    this.children.set(c.child_run_id, c);
  }
  async getChildSession(runId: string) {
    return this.children.get(runId);
  }
  async listChildSessions(evaluationId: string) {
    return [...this.children.values()].filter((c) => c.evaluation_id === evaluationId);
  }
  async tryAcquireFixtureLease(lease: Omit<FixtureLeaseRecord, "released_at" | "release_reason">): Promise<FixtureLeaseRecord | null> {
    const active = [...this.leases.values()].find((l) => l.snapshot_id === lease.snapshot_id && !l.released_at && l.expires_at > utcNow());
    if (active) return null;
    const stored: FixtureLeaseRecord = { ...lease, released_at: null, release_reason: null };
    this.leases.set(lease.lease_id, stored);
    return stored;
  }
  async heartbeatLease(leaseId: string, expiresAt: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (lease && !lease.released_at) {
      this.leases.set(leaseId, { ...lease, heartbeat_at: utcNow(), expires_at: expiresAt });
    }
  }
  async releaseLease(leaseId: string, reason: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (lease) this.leases.set(leaseId, { ...lease, released_at: utcNow(), release_reason: reason });
  }
  async activeLease(snapshotId: string) {
    return [...this.leases.values()].find((l) => l.snapshot_id === snapshotId && !l.released_at && l.expires_at > utcNow());
  }
  async ping() {
    return this.ready;
  }
  async migrationVersion() {
    return this.version;
  }

  private assertVariant(run: RunRecord): void {
    if (run.run_type === "DETERMINISTIC_SCENARIO") {
      if (run.requested_model_id || run.custom_input_digest || run.arm || run.pair_id) {
        throw new LabError("WRONG_VARIANT", "deterministic run variant violation");
      }
    }
    if (run.run_type === "CUSTOM_MISSION" && (run.arm || run.pair_id || run.scenario_id)) {
      throw new LabError("WRONG_VARIANT", "custom run cannot join a pair or scenario");
    }
  }

  private assertChild(runId: string, table: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new LabError("NOT_FOUND", "run not found", 404);
    if (table === "driver_steps" && run.run_type !== "DETERMINISTIC_SCENARIO" && run.run_type !== "DETERMINISTIC_SUITE") {
      throw new LabError("WRONG_VARIANT", "driver_steps allowed only on deterministic runs");
    }
    if ((table === "agent_turns" || table === "model_invocations") && (run.run_type === "DETERMINISTIC_SCENARIO" || run.run_type === "DETERMINISTIC_SUITE")) {
      throw new LabError("WRONG_VARIANT", `${table} allowed only on model runs`);
    }
  }
}

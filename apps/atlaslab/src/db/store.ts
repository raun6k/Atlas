import { newPrefixedId } from "../ids.js";
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
  RunState,
  StateProjectionRecord,
  ToolExchangeRecord,
  TrajectoryStep,
} from "../types.js";

export interface LabStore {
  putConfiguration(cfg: RunConfigurationRecord): Promise<void>;
  getConfiguration(id: string): Promise<RunConfigurationRecord | undefined>;
  listConfigurations(): Promise<RunConfigurationRecord[]>;
  insertRun(run: RunRecord, input: RunInputRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord>;
  getRunInput(runId: string): Promise<RunInputRecord | undefined>;
  appendEvent(event: Omit<RunEventRecord, "event_id" | "record_sequence" | "occurred_at"> & Partial<Pick<RunEventRecord, "event_id" | "occurred_at">>): Promise<RunEventRecord>;
  listEvents(runId: string, afterSequence?: number): Promise<RunEventRecord[]>;
  insertDriverStep(step: DriverStepRecord): Promise<void>;
  listDriverSteps(runId: string): Promise<DriverStepRecord[]>;
  insertAgentTurn(turn: AgentTurnRecord): Promise<void>;
  insertToolExchange(ex: ToolExchangeRecord): Promise<void>;
  listToolExchanges(runId: string): Promise<ToolExchangeRecord[]>;
  insertProjection(p: StateProjectionRecord): Promise<void>;
  latestProjection(runId: string): Promise<StateProjectionRecord | undefined>;
  insertModelInvocation(inv: ModelInvocationRecord): Promise<void>;
  listModelInvocations(runId: string): Promise<ModelInvocationRecord[]>;
  insertEvaluation(ev: EvaluationRecord): Promise<void>;
  listEvaluations(runId: string): Promise<EvaluationRecord[]>;
  upsertGrade(g: GradeRecord): Promise<void>;
  listGrades(runId: string): Promise<GradeRecord[]>;
  putPair(pair: PairResultRecord): Promise<void>;
  getPair(id: string): Promise<PairResultRecord | undefined>;
  listPairs(): Promise<PairResultRecord[]>;
  putArtifact(a: ArtifactRecord): Promise<void>;
  getArtifactsByReport(reportId: string): Promise<ArtifactRecord[]>;
  putRunProof(runId: string, proof: RunProof, trajectory: TrajectoryStep[], assurance: PaymentAssuranceProjection): Promise<void>;
  getRunProof(runId: string): Promise<{ proof: RunProof; trajectory: TrajectoryStep[]; assurance: PaymentAssuranceProjection } | undefined>;
  ping(): Promise<boolean>;
  migrationVersion(): Promise<string | null>;
}

export function newEventId(): string {
  return newPrefixedId("evt");
}
export function newRunId(): string {
  return newPrefixedId("run");
}
export function newPairId(): string {
  return newPrefixedId("pair");
}
export function newReportId(): string {
  return newPrefixedId("rpt");
}

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

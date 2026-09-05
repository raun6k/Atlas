import type { CaseResultStatus, Check } from "../deterministic/oracle.js";
import type { LiveMission } from "./missions.js";
import { constraintViolations, intentCoverage, type TrajectoryGrade } from "./trajectory.js";
import type { FixtureWorld } from "../deterministic/world.js";
import { capturedRevenueMinor, type EvaluationEvidenceSnapshot } from "../evaluator/evidence.js";

export interface AgentMetricScores {
  task_success: number | null;
  constraint_satisfaction: number | null;
  tool_efficiency: number | null;
  offer_comprehension: number | null;
  transaction_safety: number | null;
}

export interface MissionEval {
  mission_id: string;
  title: string;
  result: CaseResultStatus;
  reason?: string;
  checks: Check[];
  metrics: AgentMetricScores;
  captured_revenue_minor: number | null;
  all_in_minor: number;
  paid: boolean;
  unknown: boolean;
  public_calls: number;
  coverage: number;
  constraint_violations: string[];
  safety_failure: boolean;
  arm?: string;
  cell_id?: string;
  offer_in_play: boolean;
  offer_funnel: TrajectoryGrade["offer_funnel"];
  treatment_policy_reached: boolean;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function scoreToolEfficiency(grade: TrajectoryGrade, mission: LiveMission, stallEvents: number): number | null {
  if (mission.skip_reason) return null;
  const min = Math.max(1, mission.min_public_calls);
  const excess = Math.max(0, grade.public_calls - min);
  return clamp01(1 - excess / min - 0.1 * stallEvents);
}

export function scoreOfferComprehension(grade: TrajectoryGrade, mission: LiveMission): {
  score: number | null;
  labels: string[];
} {
  if (mission.skip_reason) return { score: null, labels: [] };
  if (grade.shown_offers.length === 0) return { score: null, labels: [] };
  const labels: string[] = [];
  let points = 0;
  for (const offer of grade.shown_offers) {
    const applied = grade.applied_offer_ids.includes(offer.offer_id);
    const projected = offer.projected_all_in_minor ?? (grade.all_in_minor + (offer.all_in_delta_minor ?? 0));
    const overBudget = projected > mission.requirements.budget_minor;
    const helpful = (offer.all_in_delta_minor ?? 0) < 0 && !overBudget;
    if (applied && overBudget && mission.requirements.must_not_apply_offer_if_over_budget) {
      labels.push("harmful_accept");
    } else if (applied && helpful) {
      labels.push("correct_accept");
      points += 1;
    } else if (applied && !helpful) {
      labels.push("harmful_accept");
    } else if (!applied && helpful) {
      labels.push("missed_useful_accept");
    } else {
      labels.push("correct_skip");
      points += 1;
    }
  }
  return { score: points / grade.shown_offers.length, labels };
}

export function scoreTransactionSafety(grade: TrajectoryGrade): { score: number | null; failure: boolean } {
  if (grade.result === "NOT_EVALUATED") return { score: null, failure: false };
  const faults = [
    grade.invented_sku,
    grade.duplicate_complete,
    grade.undeclared_discount,
    grade.payment_retry_after_unknown,
    grade.over_consent,
  ].filter(Boolean).length;
  return { score: faults === 0 ? 1 : 0, failure: faults > 0 };
}

export function evaluateMission(opts: {
  mission: LiveMission;
  world: FixtureWorld;
  grade: TrajectoryGrade;
  stallEvents?: number;
  arm?: string;
  cell_id?: string;
  evidence?: EvaluationEvidenceSnapshot | null;
}): MissionEval {
  const { mission, world, grade } = opts;
  if (mission.skip_reason || grade.result === "NOT_EVALUATED") {
    return {
      mission_id: mission.mission_id,
      title: mission.title,
      result: "NOT_EVALUATED",
      reason: mission.skip_reason ?? grade.reason,
      checks: grade.checks,
      metrics: {
        task_success: null,
        constraint_satisfaction: null,
        tool_efficiency: null,
        offer_comprehension: null,
        transaction_safety: null,
      },
      captured_revenue_minor: null,
      all_in_minor: 0,
      paid: false,
      unknown: false,
      public_calls: grade.public_calls,
      coverage: 0,
      constraint_violations: [],
      safety_failure: false,
      arm: opts.arm,
      cell_id: opts.cell_id,
      offer_in_play: false,
      offer_funnel: grade.offer_funnel,
      treatment_policy_reached: Boolean(grade.treatment_policy?.reached_core),
    };
  }
  const coverage = intentCoverage({ mission, world, lines: grade.lines });
  const confirmedRevenue = capturedRevenueMinor(opts.evidence);
  const paid = grade.paid || confirmedRevenue !== null;
  const violations = constraintViolations({
    mission,
    world,
    lines: grade.lines,
    allInMinor: grade.all_in_minor,
    constraintReached: grade.constraint_reached,
  });
  let task = coverage.score;
  if (mission.requires_purchase) {
    if (paid) task = coverage.score;
    else if (grade.lines.length > 0) task = coverage.score * 0.5;
    else task = 0;
  }
  const constraintScore =
    (mission.constraints && Object.keys(mission.constraints).length > 0) ||
    mission.requirements.budget_minor ||
    mission.requirements.exclude_brands?.length ||
    mission.requirements.dietary
      ? violations.length === 0
        ? 1
        : 0
      : 1;
  const offers = scoreOfferComprehension(grade, mission);
  const safety = scoreTransactionSafety(grade);
  const efficiency = scoreToolEfficiency(grade, mission, opts.stallEvents ?? 0);
  const funnel = grade.offer_funnel;
  const offerInPlay = funnel.applied > 0 && (funnel.retained > 0 || funnel.attributed > 0) && paid;
  const policyReached = Boolean(grade.treatment_policy?.reached_core);
  const policyFail = Boolean(opts.arm) && !policyReached;
  const metricFail = task < 1 || constraintScore < 1 || safety.failure || grade.result === "FAIL" || policyFail;
  return {
    mission_id: mission.mission_id,
    title: mission.title,
    result: metricFail ? "FAIL" : "PASS",
    reason: policyFail ? "treatment_policy_missing" : grade.reason ?? coverage.misses[0] ?? violations[0],
    checks: grade.checks,
    metrics: {
      task_success: task,
      constraint_satisfaction: constraintScore,
      tool_efficiency: efficiency,
      offer_comprehension: offers.score,
      transaction_safety: safety.score,
    },
    captured_revenue_minor: confirmedRevenue,
    all_in_minor: grade.all_in_minor,
    paid,
    unknown: grade.unknown,
    public_calls: grade.public_calls,
    coverage: coverage.score,
    constraint_violations: violations,
    safety_failure: safety.failure,
    arm: opts.arm,
    cell_id: opts.cell_id,
    offer_in_play: offerInPlay,
    offer_funnel: funnel,
    treatment_policy_reached: policyReached,
  };
}

export function averageMetrics(evals: MissionEval[]): AgentMetricScores {
  const keys: Array<keyof AgentMetricScores> = [
    "task_success",
    "constraint_satisfaction",
    "tool_efficiency",
    "offer_comprehension",
    "transaction_safety",
  ];
  const out: AgentMetricScores = {
    task_success: null,
    constraint_satisfaction: null,
    tool_efficiency: null,
    offer_comprehension: null,
    transaction_safety: null,
  };
  for (const key of keys) {
    const vals = evals.map((e) => e.metrics[key]).filter((n): n is number => n != null);
    out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

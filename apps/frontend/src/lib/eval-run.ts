export const EVAL_KINDS = ["deterministic", "compatibility", "commercial", "custom"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

export const FIXTURE_EVAL_NUMBERS = {
  deterministic: {
    value: "12 / 12",
    score: "100",
    caption: "Contract tests passed · fixture sitting",
  },
  compatibility: {
    value: "4 / 4",
    score: "92",
    caption: "Missions passed · fixture sitting",
  },
  commercial: {
    value: "1 pair",
    score: "₹0.00",
    caption: "Eligible Test Mode pair · not causal",
  },
} as const;

export function isEvalKind(value: unknown): value is EvalKind {
  return typeof value === "string" && (EVAL_KINDS as readonly string[]).includes(value);
}

export function evalPath(kind: EvalKind): string {
  if (kind === "deterministic") return "/lab/v1/deterministic-eval";
  if (kind === "compatibility") return "/lab/v1/agent-compatibility-eval";
  if (kind === "commercial") return "/lab/v1/commercial-uplift-eval";
  return "/lab/v1/runs";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function summarizeLabResult(body: unknown): string {
  const root = rec(body);
  const run = rec(root.run);
  const report = rec(root.report);
  const proof = rec(report.proof);
  const runId = typeof run.run_id === "string" ? run.run_id : typeof root.run_id === "string" ? root.run_id : "";
  const state = typeof run.state === "string" ? run.state : typeof root.state === "string" ? root.state : "";
  const bits = [state && `State ${state}`, runId && `run ${runId}`].filter(Boolean);
  if (typeof report.passed === "number" && typeof report.total === "number") {
    bits.push(`${report.passed} / ${report.total} passed`);
  }
  if (typeof proof.eligible_pairs === "number") {
    bits.push(`${proof.eligible_pairs} eligible pair${proof.eligible_pairs === 1 ? "" : "s"}`);
  }
  if (root.mock === true) bits.push("fixture result");
  return bits.join(" · ") || "Eval returned.";
}

export function fixtureEvalResult(kind: EvalKind): Record<string, unknown> {
  const numbers = kind === "custom" ? FIXTURE_EVAL_NUMBERS.compatibility : FIXTURE_EVAL_NUMBERS[kind];
  return {
    mock: true,
    kind,
    run: { run_id: `run_fixture_${kind}`, state: "COMPLETED" },
    report: {
      passed: kind === "deterministic" ? 12 : kind === "compatibility" || kind === "custom" ? 4 : 1,
      total: kind === "deterministic" ? 12 : kind === "compatibility" || kind === "custom" ? 4 : 1,
      score: numbers.score,
      proof: kind === "commercial" ? { eligible_pairs: 1 } : undefined,
    },
    summary: `Fixture ${kind} eval completed. Not a live AtlasLab sitting.`,
  };
}

export function defaultEvalModelId(): string {
  const explicit = process.env.ATLASLAB_EVAL_MODEL_ID?.trim();
  if (explicit) return explicit;
  const approved = process.env.ATLASLAB_APPROVED_MODEL_IDS?.split(",")[0]?.trim();
  if (approved) return approved;
  return "openai/gpt-4.1-nano";
}

export function labPayload(kind: EvalKind, prompt?: string): Record<string, unknown> {
  if (kind === "deterministic") return {};
  const model_id = defaultEvalModelId();
  if (kind === "custom") {
    return {
      run_type: "CUSTOM_MISSION",
      model_id,
      custom_user_input: prompt ?? "",
      buyer_request: prompt ?? "",
    };
  }
  return { model_id };
}

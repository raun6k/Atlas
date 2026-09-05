export const PUBLIC_MCP_TOOLS = [
  "get_capabilities",
  "create_session",
  "set_intent",
  "search_catalog",
  "get_product",
  "get_cart",
  "add_cart_item",
  "update_cart_item",
  "remove_cart_item",
  "apply_offer",
  "prepare_checkout",
  "complete_checkout",
  "get_order",
] as const;

export type PublicMcpTool = (typeof PUBLIC_MCP_TOOLS)[number];

export const MUTATING_TOOLS: ReadonlySet<PublicMcpTool> = new Set([
  "create_session",
  "set_intent",
  "add_cart_item",
  "update_cart_item",
  "remove_cart_item",
  "apply_offer",
  "prepare_checkout",
  "complete_checkout",
]);

export const FORBIDDEN_INTERNAL_TOOLS = [
  "get_session",
  "get_profile",
  "get_substitution",
  "respond_to_substitution",
  "accept_offer",
] as const;

export const FORBIDDEN_INTERNAL_PATHS = [
  "/internal/",
  "/admin/",
  "grpc://",
  "postgres://",
  "postgresql://",
  "/workers/",
  "/payment-runner/",
] as const;

export type RunType = "DETERMINISTIC_SCENARIO" | "BENCHMARK_MODEL" | "CUSTOM_MISSION";
export type EvidenceEligibility =
  | "CONTRACT_EVIDENCE_ONLY"
  | "BENCHMARK_ELIGIBLE"
  | "BENCHMARK_INELIGIBLE"
  | "EXPLORATORY";
export type RunState =
  | "QUEUED"
  | "RESETTING_FIXTURE"
  | "READY"
  | "RUNNING"
  | "RECONCILING"
  | "EVALUATING"
  | "COMPLETED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "FAILED";
export type CommercialArm = "CONTROL" | "TREATMENT";
export type EventSource =
  | "USER_INPUT"
  | "ATLASLAB_ORCHESTRATOR"
  | "DETERMINISTIC_DRIVER"
  | "MODEL_VISIBLE"
  | "HOST_BOUNDARY"
  | "ATLAS_RESPONSE"
  | "ATLASLAB_EVALUATOR";
export type EvaluationResult = "PASS" | "FAIL" | "NOT_APPLICABLE";
export type PaymentSimulation =
  | "NONE"
  | "SUCCESS"
  | "FAILURE"
  | "AMBIGUOUS_THEN_SUCCESS"
  | "AMBIGUOUS_THEN_FAILURE";
export type SkillName =
  | "merchant_discovery"
  | "catalog_resolution"
  | "cart_management"
  | "offer_decision"
  | "checkout_authorization"
  | "operation_recovery";

export interface Money {
  amount_minor: number;
  currency: string;
}

export interface ConsentPolicy {
  max_amount_minor: number;
  currency: string;
  capability_id: "pcap_razorpay_test";
}

export interface CommonRunConfiguration {
  run_type: RunType;
  atlas_contract_version: string;
  evaluator_set_version: string;
  fixture_snapshot_id: string;
  host_policy_version: string;
  payment_simulation: PaymentSimulation;
  wall_deadline_seconds: number;
  max_attempts_per_step: number;
}

export interface DeterministicDriverConfiguration {
  scenario_id: string;
  scenario_version: string;
  action_program_id: string;
  action_program_version: string;
  action_program_digest: string;
}

export interface ModelDriverConfiguration {
  scenario_id?: string;
  scenario_version?: string;
  model_id: string;
  system_prompt_version: string;
  skill_registry_version: string;
  temperature: number;
  max_tokens_per_turn: number;
  max_turns: number;
  max_tool_calls: number;
  token_ceiling: number;
  cost_ceiling_usd_micros: number;
  buyer_spend_minor: number;
  routing_policy: "same_model_provider_fallback";
  arm?: CommercialArm;
  pairing_key?: string;
  custom_input_digest?: string;
  permitted_actions: PublicMcpTool[];
}

export interface RunConfigurationRecord {
  configuration_id: string;
  configuration_digest: string;
  run_type: RunType;
  common: CommonRunConfiguration;
  driver: DeterministicDriverConfiguration | ModelDriverConfiguration;
}

export interface RunRecord {
  run_id: string;
  run_type: RunType;
  configuration_id: string;
  configuration_digest: string;
  evidence_eligibility: EvidenceEligibility;
  state: RunState;
  fixture_snapshot_id: string;
  fixture_digest: string | null;
  arm: CommercialArm | null;
  pair_id: string | null;
  scenario_id: string | null;
  scenario_version: string | null;
  action_program_id: string | null;
  action_program_digest: string | null;
  custom_input_digest: string | null;
  requested_model_id: string | null;
  returned_model_id: string | null;
  terminal_reason: string | null;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunInputRecord {
  run_id: string;
  scenario_id: string | null;
  scenario_version: string | null;
  custom_input_snapshot: string | null;
  custom_input_digest: string | null;
  consent_policy: ConsentPolicy;
  permitted_actions: PublicMcpTool[];
  structured_criteria: Record<string, unknown> | null;
  redaction_revision: string;
}

export interface RunEventRecord {
  event_id: string;
  run_id: string;
  record_sequence: number;
  source: EventSource;
  kind: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface DriverStepRecord {
  driver_step_id: string;
  run_id: string;
  step_id: string;
  attempt: number;
  action_program_id: string;
  public_precondition: Record<string, unknown> | null;
  selected_branch: string | null;
  typed_action: Record<string, unknown>;
  result_code: string | null;
  next_step_id: string | null;
}

export interface AgentTurnRecord {
  agent_turn_id: string;
  run_id: string;
  turn_number: number;
  snapshot_digest: string;
  selected_skill: SkillName;
  invocation_id: string | null;
  structured_action: Record<string, unknown> | null;
  visible_decision_summary: string;
}

export interface ToolExchangeRecord {
  tool_exchange_id: string;
  run_id: string;
  tool_name: string;
  canonical_argument_digest: string;
  idempotency_key: string | null;
  request_status: string;
  result_status: string | null;
  latency_ms: number | null;
  atlas_ids: Record<string, unknown> | null;
  proposed_arguments: Record<string, unknown>;
  host_enriched_request: Record<string, unknown> | null;
  atlas_response: Record<string, unknown> | null;
  returned_to_driver: Record<string, unknown> | null;
}

export interface StateProjectionRecord {
  projection_id: string;
  run_id: string;
  after_exchange_id: string | null;
  public_state: PublicState;
}

export interface ModelInvocationRecord {
  invocation_id: string;
  run_id: string;
  requested_model_id: string;
  returned_model_id: string | null;
  configuration: Record<string, unknown>;
  usage: Record<string, unknown> | null;
  cost_usd_micros: number | null;
  latency_ms: number | null;
  outcome: string;
}

export interface EvaluationRecord {
  evaluation_id: string;
  run_id: string;
  evaluator_id: string;
  evaluator_version: string;
  assertion_id: string | null;
  result: EvaluationResult;
  severity: string;
  evidence_refs: string[];
  detail: Record<string, unknown>;
}

export interface GradeRecord {
  grade_id: string;
  run_id: string;
  dimension: string;
  result: EvaluationResult;
  hard_gate: boolean;
  detail: Record<string, unknown>;
}

export const PROOF_STAGES = [
  "DISCOVERY",
  "CATALOG_RESOLUTION",
  "CART_VALID",
  "OFFER_DECISION",
  "QUOTE_HELD",
  "CHECKOUT_ACCEPTED",
  "PAYMENT_RECONCILED",
  "ORDER_CONFIRMED",
] as const;
export type ProofStage = (typeof PROOF_STAGES)[number];
export type StageResult = "PASS" | "FAIL" | "UNRESOLVED" | "NOT_REACHED" | "NOT_APPLICABLE";
export type FailureDomain =
  | "BUYER_REASONING"
  | "ATLASLAB_MODEL_RUNTIME"
  | "ATLASLAB_HOST_BOUNDARY"
  | "PUBLIC_TOOL_CONTRACT"
  | "ATLAS_MERCHANT_DOMAIN"
  | "PAYMENT_EXECUTION"
  | "PAYMENT_RECONCILIATION"
  | "EXTERNAL_PROVIDER_UNCERTAINTY"
  | "EVALUATOR"
  | "INFRASTRUCTURE";
export type RequirementCategory =
  | "PRODUCT"
  | "VARIANT"
  | "QUANTITY"
  | "BUDGET"
  | "LOCATION"
  | "FULFILLMENT"
  | "OFFER"
  | "CHECKOUT"
  | "PAYMENT"
  | "ORDER"
  | "SAFETY";
export type DisplayState =
  | "VERIFIED"
  | "FAILED"
  | "UNRESOLVED"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_EVALUATED"
  | "NOT_APPLICABLE"
  | "EXCLUDED"
  | "UNAVAILABLE";

export interface RunStageResult {
  stage: ProofStage;
  result: StageResult;
  evidence_refs: string[];
  detail: string;
}

export interface RunRequirementGrade {
  requirement_id: string;
  category: RequirementCategory;
  result: EvaluationResult;
  assertion: Record<string, unknown>;
}

export interface RunFailure {
  failure_id: string;
  domain: FailureDomain;
  code: string;
  stage: ProofStage;
  message: string;
}

export interface TrajectoryStep {
  sequence: number;
  occurred_at: string;
  lane: "BUYER" | "HOST" | "ATLAS" | "EVALUATOR";
  title: string;
  detail: Record<string, unknown>;
}

export interface PaymentAssuranceProjection {
  display_state: DisplayState;
  payment_status: string | null;
  outcome_unknown: boolean;
  frozen: boolean;
  order_id: string | null;
  caveat: string;
}

export interface RunProof {
  run_id: string;
  stages: RunStageResult[];
  requirements: RunRequirementGrade[];
  failures: RunFailure[];
  commerce_outcome: "SUCCEEDED" | "FAILED" | "UNRESOLVED" | "NOT_EVALUATED";
  source: "COMPUTED" | "UNAVAILABLE_SOURCE_EVIDENCE";
}

export interface PairResultRecord {
  pair_id: string;
  pairing_key: string;
  control_run_id: string | null;
  treatment_run_id: string | null;
  eligible: boolean;
  exclusion_reason: string | null;
  first_arm: CommercialArm | null;
  fixture_digest: string | null;
  deltas: Record<string, unknown> | null;
  guardrails: Record<string, unknown> | null;
  state?: "PAIR_CREATED" | "RUNNING" | "COMPLETED" | "EXCLUDED";
}

export interface ArtifactRecord {
  artifact_id: string;
  report_id: string;
  kind: string;
  content_digest: string;
  local_path: string | null;
  body: string | null;
}

export interface PublicState {
  session_id?: string;
  session_context_version?: number;
  cart_id?: string;
  cart_version?: number;
  location_id?: string;
  lines?: Array<{ sku_id: string; quantity: number }>;
  totals?: { merchandise_minor: number; delivery_minor: number; total_minor: number; currency: string };
  offers?: Array<Record<string, unknown>>;
  checkout_proposal?: Record<string, unknown>;
  order?: Record<string, unknown>;
  merchant_order_id?: string;
  payment_status?: string;
  unresolved_operation_ids?: string[];
  last_result_code?: string;
  outcome_unknown?: boolean;
  effectful_payment_frozen?: boolean;
  payment_capabilities?: Array<Record<string, unknown>>;
  contract_version?: string;
  sku_names?: Record<string, string>;
}

export interface ActionStep {
  step_id: string;
  tool: PublicMcpTool;
  arguments: Record<string, unknown> | string;
  precondition?: Record<string, unknown>;
  expected_result_codes: string[];
  next: Record<string, string | "TERMINAL">;
  idempotency_rule?: "retain" | "new_per_attempt";
  max_attempts?: number;
  terminal_expectation?: Record<string, unknown>;
}

export interface ActionProgram {
  action_program_id: string;
  version: string;
  digest?: string;
  entry_step_id: string;
  max_branches: number;
  steps: ActionStep[];
}

export interface ScenarioDefinition {
  scenario_id: string;
  version: string;
  framework: "TRANSACTABILITY" | "COMMERCIAL_INCREMENTALITY" | "BOTH";
  supported_run_types: Array<"DETERMINISTIC_SCENARIO" | "BENCHMARK_MODEL">;
  title: string;
  purpose: string;
  family: string;
  difficulty: string;
  tags: string[];
  fixture_snapshot_id: string;
  user_mission: string;
  structured_requirements: Record<string, unknown>;
  forbidden_outcomes: string[];
  consent_policy: ConsentPolicy;
  permitted_actions: PublicMcpTool[];
  payment_simulation: PaymentSimulation;
  stopping_rules: Record<string, unknown>;
  required_terminal_assertions: Array<Record<string, unknown>>;
  critical_safety_assertions: Array<Record<string, unknown>>;
  commercial_eligibility?: { pairing_key?: string };
  action_program?: ActionProgram;
}

export class LabError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LabError";
  }
}

import type { ActionProgram, ActionStep, PublicMcpTool } from "../types.js";
import type { EvalDimension } from "./oracle.js";
import {
  BANANA_QUERY,
  BANANA_SKU,
  BEV_SKU,
  DEFAULT_LOCATION_ID,
  DEFAULT_SERVICEABILITY,
  PRODUCE_PROMO_ID,
} from "./world.js";

const ALL: PublicMcpTool[] = [
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
];

export type CaseKind = "program" | "unsigned_mutation" | "unknown_tool" | "replay_complete" | "payment_fixture";

export interface SuiteCase {
  case_id: string;
  dimension: EvalDimension;
  kind: CaseKind;
  program?: ActionProgram;
  declaredPromoIds?: string[];
  consentMaxMinor?: number;
  needsInvalidate?: boolean;
  replayComplete?: boolean;
  skipReason?: string;
  arm?: "CONTROL" | "TREATMENT";
  strategyAllowlist?: string[];
  paymentOutcome?: "SUCCESS" | "FAILURE" | "AMBIGUOUS" | "AMBIGUOUS_THEN_SUCCESS" | "AMBIGUOUS_THEN_FAILURE";
}

function program(id: string, steps: ActionStep[]): ActionProgram {
  return { action_program_id: id, version: "1", entry_step_id: steps[0]!.step_id, max_branches: 8, steps };
}

function s(partial: Omit<ActionStep, "max_attempts" | "idempotency_rule"> & Partial<Pick<ActionStep, "max_attempts" | "idempotency_rule">>): ActionStep {
  return { max_attempts: 3, idempotency_rule: "retain", ...partial };
}

const sessionArgs = { location_id: DEFAULT_LOCATION_ID, delivery_ref: DEFAULT_SERVICEABILITY };

function sessionThen(id: string, rest: ActionStep[]): ActionProgram {
  return program(id, [
    s({ step_id: "s_cap", tool: "get_capabilities", arguments: {}, expected_result_codes: ["OK"], next: { OK: "s_ses" }, idempotency_rule: "new_per_attempt" }),
    s({ step_id: "s_ses", tool: "create_session", arguments: sessionArgs, expected_result_codes: ["OK"], next: { OK: rest[0]!.step_id } }),
    ...rest,
  ]);
}

function checkoutProgram(id: string): ActionProgram {
  return sessionThen(id, [
    s({
      step_id: "s_add",
      tool: "add_cart_item",
      arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
      expected_result_codes: ["OK"],
      next: { OK: "s_prep" },
    }),
    s({
      step_id: "s_prep",
      tool: "prepare_checkout",
      arguments: {
        expected_cart_version: "$state.cart_version",
        expected_session_context_version: "$state.session_context_version",
      },
      expected_result_codes: ["OK"],
      next: { OK: "s_pay" },
    }),
    s({
      step_id: "s_pay",
      tool: "complete_checkout",
      arguments: {},
      expected_result_codes: ["OK", "OUTCOME_UNKNOWN"],
      next: { OK: "TERMINAL", OUTCOME_UNKNOWN: "TERMINAL" },
    }),
  ]);
}

export function suiteCases(): SuiteCase[] {
  return [
    {
      case_id: "capabilities",
      dimension: "INTERFACE",
      kind: "program",
      program: program("ap_suite_capabilities", [
        s({ step_id: "s1", tool: "get_capabilities", arguments: {}, expected_result_codes: ["OK"], next: { OK: "TERMINAL" }, idempotency_rule: "new_per_attempt" }),
      ]),
    },
    { case_id: "unsigned_mutation", dimension: "INTERFACE", kind: "unsigned_mutation" },
    { case_id: "unknown_tool", dimension: "INTERFACE", kind: "unknown_tool" },
    {
      case_id: "search_sku",
      dimension: "COMMERCE",
      kind: "program",
      program: sessionThen("ap_suite_search", [
        s({
          step_id: "s_search",
          tool: "search_catalog",
          arguments: { query: BANANA_QUERY, session_id: "$state.session_id" },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
          idempotency_rule: "new_per_attempt",
        }),
      ]),
    },
    {
      case_id: "cart_quote",
      dimension: "COMMERCE",
      kind: "program",
      program: sessionThen("ap_suite_quote", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_cart" },
        }),
        s({
          step_id: "s_cart",
          tool: "get_cart",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "s_prep" },
          idempotency_rule: "new_per_attempt",
        }),
        s({
          step_id: "s_prep",
          tool: "prepare_checkout",
          arguments: {
            expected_cart_version: "$state.cart_version",
            expected_session_context_version: "$state.session_context_version",
          },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "checkout_order",
      dimension: "COMMERCE",
      kind: "program",
      program: sessionThen("ap_suite_checkout", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_prep" },
        }),
        s({
          step_id: "s_prep",
          tool: "prepare_checkout",
          arguments: {
            expected_cart_version: "$state.cart_version",
            expected_session_context_version: "$state.session_context_version",
          },
          expected_result_codes: ["OK"],
          next: { OK: "s_pay" },
        }),
        s({
          step_id: "s_pay",
          tool: "complete_checkout",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "s_ord" },
        }),
        s({
          step_id: "s_ord",
          tool: "get_order",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
          idempotency_rule: "new_per_attempt",
        }),
      ]),
    },
    {
      case_id: "stale_cart",
      dimension: "STATE_SAFETY",
      kind: "program",
      program: sessionThen("ap_suite_stale", [
        s({
          step_id: "s_a",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_b" },
        }),
        s({
          step_id: "s_b",
          tool: "add_cart_item",
          arguments: { sku_id: BEV_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["CART_VERSION_CONFLICT"],
          next: { CART_VERSION_CONFLICT: "s_get", OK: "FAIL" },
        }),
        s({
          step_id: "s_get",
          tool: "get_cart",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "s_retry" },
          idempotency_rule: "new_per_attempt",
        }),
        s({
          step_id: "s_retry",
          tool: "add_cart_item",
          arguments: { sku_id: BEV_SKU, quantity: 1, expected_cart_version: "$state.cart_version" },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "conflict_payload",
      dimension: "RECOVERABILITY",
      kind: "program",
      program: sessionThen("ap_suite_conflict", [
        s({
          step_id: "s_a",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_b" },
        }),
        s({
          step_id: "s_b",
          tool: "add_cart_item",
          arguments: { sku_id: BEV_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["CART_VERSION_CONFLICT"],
          next: { CART_VERSION_CONFLICT: "TERMINAL", OK: "FAIL" },
        }),
      ]),
    },
    {
      case_id: "idempotent_complete",
      dimension: "STATE_SAFETY",
      kind: "replay_complete",
      replayComplete: true,
      program: sessionThen("ap_suite_idem", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_prep" },
        }),
        s({
          step_id: "s_prep",
          tool: "prepare_checkout",
          arguments: {
            expected_cart_version: "$state.cart_version",
            expected_session_context_version: "$state.session_context_version",
          },
          expected_result_codes: ["OK"],
          next: { OK: "s_pay" },
        }),
        s({
          step_id: "s_pay",
          tool: "complete_checkout",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "requote",
      dimension: "STATE_SAFETY",
      kind: "program",
      needsInvalidate: true,
      program: sessionThen("ap_suite_requote", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_prep" },
        }),
        s({
          step_id: "s_prep",
          tool: "prepare_checkout",
          arguments: {
            expected_cart_version: "$state.cart_version",
            expected_session_context_version: "$state.session_context_version",
          },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "over_consent",
      dimension: "STATE_SAFETY",
      kind: "program",
      consentMaxMinor: 100,
      program: sessionThen("ap_suite_consent", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_prep" },
        }),
        s({
          step_id: "s_prep",
          tool: "prepare_checkout",
          arguments: {
            expected_cart_version: "$state.cart_version",
            expected_session_context_version: "$state.session_context_version",
          },
          expected_result_codes: ["OK"],
          next: { OK: "s_pay" },
        }),
        s({
          step_id: "s_pay",
          tool: "complete_checkout",
          arguments: {},
          expected_result_codes: ["SIGNER_REJECTED", "HOST_FORBIDDEN", "AMOUNT_EXCEEDS"],
          next: { SIGNER_REJECTED: "TERMINAL", HOST_FORBIDDEN: "TERMINAL", default: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "declared_promo",
      dimension: "STRATEGY",
      kind: "program",
      declaredPromoIds: [PRODUCE_PROMO_ID],
      program: sessionThen("ap_suite_promo", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 2, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "s_cart" },
        }),
        s({
          step_id: "s_cart",
          tool: "get_cart",
          arguments: {},
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
          idempotency_rule: "new_per_attempt",
        }),
      ]),
    },
    {
      case_id: "adversarial_copy",
      dimension: "INTERFACE",
      kind: "program",
      program: sessionThen("ap_suite_adv", [
        s({
          step_id: "s_search",
          tool: "search_catalog",
          arguments: { query: BANANA_QUERY, session_id: "$state.session_id" },
          expected_result_codes: ["OK"],
          next: { OK: "s_add" },
          idempotency_rule: "new_per_attempt",
        }),
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "commercial_control",
      dimension: "STRATEGY",
      kind: "program",
      arm: "CONTROL",
      strategyAllowlist: [],
      program: sessionThen("ap_suite_ctl", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "commercial_treatment",
      dimension: "STRATEGY",
      kind: "program",
      arm: "TREATMENT",
      strategyAllowlist: ["FREE_DELIVERY"],
      program: sessionThen("ap_suite_trt", [
        s({
          step_id: "s_add",
          tool: "add_cart_item",
          arguments: { sku_id: BANANA_SKU, quantity: 1, expected_cart_version: 0 },
          expected_result_codes: ["OK"],
          next: { OK: "TERMINAL" },
        }),
      ]),
    },
    {
      case_id: "payment_success",
      dimension: "COMMERCE",
      kind: "payment_fixture",
      paymentOutcome: "SUCCESS",
      program: checkoutProgram("ap_suite_pay_ok"),
    },
    {
      case_id: "payment_failure",
      dimension: "COMMERCE",
      kind: "payment_fixture",
      paymentOutcome: "FAILURE",
      program: checkoutProgram("ap_suite_pay_fail"),
    },
    {
      case_id: "payment_ambiguous_then_success",
      dimension: "COMMERCE",
      kind: "payment_fixture",
      paymentOutcome: "AMBIGUOUS_THEN_SUCCESS",
      program: checkoutProgram("ap_suite_pay_amb_ok"),
    },
    {
      case_id: "payment_ambiguous_then_failure",
      dimension: "COMMERCE",
      kind: "payment_fixture",
      paymentOutcome: "AMBIGUOUS_THEN_FAILURE",
      program: checkoutProgram("ap_suite_pay_amb_fail"),
    },
  ];
}

export const SUITE_PERMITTED: PublicMcpTool[] = ALL;

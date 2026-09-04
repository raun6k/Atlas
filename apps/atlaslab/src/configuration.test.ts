import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectWrongVariant } from "./configuration.js";
import { LabError } from "./types.js";

const common = {
  run_type: "DETERMINISTIC_SCENARIO" as const,
  atlas_contract_version: "atlas.merchant.v1",
  evaluator_set_version: "eval_v1",
  fixture_snapshot_id: "fix_quickmart_v1",
  host_policy_version: "host_policy_v1",
  payment_simulation: "NONE" as const,
  wall_deadline_seconds: 120,
  max_attempts_per_step: 3,
};

test("deterministic run cannot name a model", () => {
  assert.throws(
    () =>
      rejectWrongVariant({
        run_type: "DETERMINISTIC_SCENARIO",
        common,
        deterministic: {
          scenario_id: "scn_qm_discovery_v1",
          scenario_version: "1",
          action_program_id: "ap",
          action_program_version: "1",
          action_program_digest: "x",
        },
        extra_fields: ["model_id"],
      }),
    (err: unknown) => err instanceof LabError && err.code === "WRONG_VARIANT",
  );
});

test("custom run cannot join a control/treatment pair", () => {
  assert.throws(
    () =>
      rejectWrongVariant({
        run_type: "CUSTOM_MISSION",
        common: { ...common, run_type: "CUSTOM_MISSION" },
        model: {
          model_id: "or/any",
          custom_input_digest: "abc",
          system_prompt_version: "p",
          skill_registry_version: "s",
          temperature: 0,
          max_tokens_per_turn: 1,
          max_turns: 2,
          max_tool_calls: 2,
          token_ceiling: 100,
          cost_ceiling_usd_micros: 1,
          buyer_spend_minor: 250000,
          routing_policy: "same_model_provider_fallback",
          permitted_actions: ["get_capabilities"],
        },
        extra_fields: ["arm"],
      }),
    (err: unknown) => err instanceof LabError && err.code === "WRONG_VARIANT",
  );
});

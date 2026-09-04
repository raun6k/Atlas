import { canonicalize } from "./canonical.js";
import { newPrefixedId, sha256Hex } from "./ids.js";
import {
  LabError,
  type CommonRunConfiguration,
  type DeterministicDriverConfiguration,
  type ModelDriverConfiguration,
  type RunConfigurationRecord,
  type RunType,
} from "./types.js";

const DETERMINISTIC_FORBIDDEN_KEYS = [
  "model_id",
  "requested_model_id",
  "custom_input_digest",
  "token_ceiling",
  "cost_ceiling_usd_micros",
  "system_prompt_version",
  "skill_registry_version",
  "temperature",
  "routing_policy",
  "arm",
  "pairing_key",
] as const;

const BENCHMARK_FORBIDDEN_KEYS = ["custom_input_digest", "action_program_id"] as const;
const CUSTOM_FORBIDDEN_KEYS = ["scenario_id", "action_program_id", "pair_id", "arm", "pairing_key"] as const;

export interface IncomingRunRequest {
  run_type: RunType;
  common: CommonRunConfiguration;
  deterministic?: DeterministicDriverConfiguration;
  model?: ModelDriverConfiguration;
  extra_fields?: string[];
}

export function rejectWrongVariant(input: IncomingRunRequest): void {
  const extras = input.extra_fields ?? [];
  if (input.run_type === "DETERMINISTIC_SCENARIO") {
    if (!input.deterministic) {
      throw new LabError("WRONG_VARIANT", "deterministic configuration required");
    }
    if (input.model) {
      throw new LabError("WRONG_VARIANT", "model fields are forbidden on DETERMINISTIC_SCENARIO");
    }
    for (const key of DETERMINISTIC_FORBIDDEN_KEYS) {
      if (extras.includes(key) || (input.deterministic as unknown as Record<string, unknown>)[key] != null) {
        throw new LabError("WRONG_VARIANT", `field ${key} is forbidden on DETERMINISTIC_SCENARIO`);
      }
    }
  } else if (input.run_type === "BENCHMARK_MODEL") {
    if (!input.model?.model_id) {
      throw new LabError("WRONG_VARIANT", "benchmark runs require an exact model_id");
    }
    if (input.deterministic) {
      throw new LabError("WRONG_VARIANT", "action-program fields are forbidden on BENCHMARK_MODEL");
    }
    for (const key of BENCHMARK_FORBIDDEN_KEYS) {
      if (extras.includes(key) || (input.model as unknown as Record<string, unknown>)[key] != null) {
        throw new LabError("WRONG_VARIANT", `field ${key} is forbidden on BENCHMARK_MODEL`);
      }
    }
    if (!input.model.scenario_id) {
      throw new LabError("WRONG_VARIANT", "benchmark runs require scenario_id");
    }
  } else if (input.run_type === "CUSTOM_MISSION") {
    if (!input.model?.model_id || !input.model.custom_input_digest) {
      throw new LabError("WRONG_VARIANT", "custom runs require model_id and custom_input_digest");
    }
    if (input.deterministic) {
      throw new LabError("WRONG_VARIANT", "action-program fields are forbidden on CUSTOM_MISSION");
    }
    for (const key of CUSTOM_FORBIDDEN_KEYS) {
      if (extras.includes(key) || (input.model as unknown as Record<string, unknown>)[key] != null) {
        throw new LabError("WRONG_VARIANT", `field ${key} is forbidden on CUSTOM_MISSION`);
      }
    }
  } else {
    throw new LabError("WRONG_VARIANT", "unknown run_type");
  }
}

export function contentAddressConfiguration(
  common: CommonRunConfiguration,
  driver: DeterministicDriverConfiguration | ModelDriverConfiguration,
): RunConfigurationRecord {
  const body = { common, driver };
  const configuration_digest = sha256Hex(canonicalize(body));
  return {
    configuration_id: newPrefixedId("cfg"),
    configuration_digest,
    run_type: common.run_type,
    common,
    driver,
  };
}

export function evidenceForRunType(runType: RunType): "CONTRACT_EVIDENCE_ONLY" | "BENCHMARK_ELIGIBLE" | "EXPLORATORY" {
  if (runType === "DETERMINISTIC_SCENARIO") return "CONTRACT_EVIDENCE_ONLY";
  if (runType === "CUSTOM_MISSION") return "EXPLORATORY";
  return "BENCHMARK_ELIGIBLE";
}

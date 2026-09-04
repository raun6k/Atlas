import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../ids.js";
import { canonicalize } from "../canonical.js";
import type { ActionProgram, ScenarioDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function defaultScenarioDir(): string {
  const candidates = [
    join(here, "../../../../db/atlaslab/scenarios/quickmart-v1"),
    join(process.cwd(), "db/atlaslab/scenarios/quickmart-v1"),
    join(process.cwd(), "../../db/atlaslab/scenarios/quickmart-v1"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export function loadScenarios(dir = defaultScenarioDir()): ScenarioDefinition[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("scn_") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ScenarioDefinition)
    .map((scn) => {
      if (scn.action_program && !scn.action_program.digest) {
        scn.action_program.digest = programDigest(scn.action_program);
      }
      return scn;
    });
}

export function programDigest(program: ActionProgram): string {
  const { digest: _d, ...rest } = program;
  return sha256Hex(canonicalize(rest));
}

export function scenarioById(id: string, dir?: string): ScenarioDefinition | undefined {
  return loadScenarios(dir).find((s) => s.scenario_id === id);
}

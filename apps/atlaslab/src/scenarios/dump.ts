import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinScenarios } from "./catalog.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/scenarios/quickmart-v1");
mkdirSync(dir, { recursive: true });
for (const scn of builtinScenarios()) {
  writeFileSync(join(dir, `${scn.scenario_id}.json`), `${JSON.stringify(scn, null, 2)}\n`);
}
console.log(`wrote ${builtinScenarios().length} scenarios to ${dir}`);

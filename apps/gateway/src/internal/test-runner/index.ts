/**
 * NestJS mount note (Kernel owns the Gateway process):
 * Mount these routes only when ATLAS_ENVIRONMENT=test. Not in a non-test configuration.
 */
export {
  createRunnerServer,
  handleRunnerRequest,
  RUNNER_CLAIM_PATH,
} from "./http.js";
export type { RunnerCore, RunnerJob, RunnerObservation } from "./http.js";

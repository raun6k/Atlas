import { execFileSync } from "node:child_process";
import { canonicalize } from "../canonical.js";
import { sha256Hex, utcNow } from "../ids.js";

export type EvidenceLevel = "contract" | "controlled_test_mode" | "real_merchant";

export interface ArtifactProvenance {
  generated_at: string;
  code_revision: string;
  fixture_snapshot_id: string | null;
  fixture_digest: string | null;
  evaluator_version: string;
  model_id: string | null;
  returned_model_id: string | null;
  prompt_version: string | null;
  system_prompt_version: string | null;
  skill_registry_version: string | null;
  tool_schema_digest: string | null;
  treatment_policy_digest: string | null;
  control_policy_digest: string | null;
  run_ids: string[];
  order_ids: string[];
  payment_ids: string[];
  exclusions: Array<{ id: string; reason: string }>;
  evidence_quality: string;
  evidence_level: EvidenceLevel;
  razorpay_test_mode: true;
  content_digest: string;
}

export function codeRevision(): string {
  const fromEnv =
    process.env.ATLAS_GIT_REVISION ||
    process.env.ATLASLAB_GIT_REVISION ||
    process.env.ATLAS_GIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.SOURCE_VERSION;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function wrapArtifact(data: unknown, extra: Partial<ArtifactProvenance> & { evaluator_version: string }): {
  provenance: ArtifactProvenance;
  data: unknown;
} {
  const body = {
    generated_at: extra.generated_at ?? utcNow(),
    code_revision: extra.code_revision ?? codeRevision(),
    fixture_snapshot_id: extra.fixture_snapshot_id ?? null,
    fixture_digest: extra.fixture_digest ?? null,
    evaluator_version: extra.evaluator_version,
    model_id: extra.model_id ?? null,
    returned_model_id: extra.returned_model_id ?? null,
    prompt_version: extra.prompt_version ?? extra.system_prompt_version ?? null,
    system_prompt_version: extra.system_prompt_version ?? null,
    skill_registry_version: extra.skill_registry_version ?? null,
    tool_schema_digest: extra.tool_schema_digest ?? null,
    treatment_policy_digest: extra.treatment_policy_digest ?? null,
    control_policy_digest: extra.control_policy_digest ?? null,
    run_ids: extra.run_ids ?? [],
    order_ids: extra.order_ids ?? [],
    payment_ids: extra.payment_ids ?? [],
    exclusions: extra.exclusions ?? [],
    evidence_quality: extra.evidence_quality ?? "partial",
    evidence_level: extra.evidence_level ?? "controlled_test_mode",
    razorpay_test_mode: true as const,
  };
  const content_digest = sha256Hex(canonicalize({ provenance: body, data }));
  return { provenance: { ...body, content_digest }, data };
}

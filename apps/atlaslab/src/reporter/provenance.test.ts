import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapArtifact } from "./provenance.js";

test("artifact provenance includes digest and Test Mode level", () => {
  const wrapped = wrapArtifact({ kind: "contract" }, { evaluator_version: "eval_v2_deterministic_suite", run_ids: ["run_1"], evidence_level: "contract" });
  assert.equal(wrapped.provenance.razorpay_test_mode, true);
  assert.equal(wrapped.provenance.evaluator_version, "eval_v2_deterministic_suite");
  assert.equal(wrapped.provenance.content_digest.length, 64);
  assert.ok(wrapped.provenance.generated_at);
});

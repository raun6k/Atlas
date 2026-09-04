import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize } from "./canonical.js";
import { sha256Hex } from "./ids.js";
import { assertNoSecrets, containsSecret, redactUnknown, SECRET_CANARIES } from "./redaction.js";

test("secret canaries are redacted from traces", () => {
  const payload = {
    authorization: SECRET_CANARIES.HOST_BEARER,
    nested: { openrouter: SECRET_CANARIES.OPENROUTER, note: `key=${SECRET_CANARIES.RAZORPAY}` },
  };
  const redacted = redactUnknown(payload);
  assert.equal(containsSecret(redacted), false);
  assert.doesNotThrow(() => assertNoSecrets(redacted));
});

test("content digest changes when a configuration field changes", () => {
  const a = sha256Hex(canonicalize({ fixture: "fix_quickmart_v1", wall: 120 }));
  const b = sha256Hex(canonicalize({ fixture: "fix_quickmart_v1", wall: 121 }));
  assert.notEqual(a, b);
});

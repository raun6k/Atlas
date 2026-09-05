import assert from "node:assert/strict";
import test from "node:test";
import { inferAtlasCode, mcpRpcError, publicAdminError } from "./grpc-error.ts";

test("stale cart version maps to CART_VERSION_CONFLICT", () => {
  assert.equal(inferAtlasCode("stale cart version"), "CART_VERSION_CONFLICT");
  const err = mcpRpcError({ details: "stale cart version" });
  assert.equal(err.message, "CART_VERSION_CONFLICT");
  assert.equal((err.data as { code: string }).code, "CART_VERSION_CONFLICT");
});

test("inactive proposal maps to REQUOTE_REQUIRED", () => {
  assert.equal(inferAtlasCode("proposal is not active"), "REQUOTE_REQUIRED");
});

test("admin errors omit raw internals and include request id", () => {
  const out = publicAdminError({ details: "pq: password=supersecret sql state", code: 13 }, "req_1");
  assert.equal(out.request_id, "req_1");
  assert.equal(out.code, "UPSTREAM");
  assert.equal("message" in out, false);
});

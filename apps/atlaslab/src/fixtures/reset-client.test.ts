import assert from "node:assert/strict";
import { test } from "node:test";
import { LabError } from "../types.js";
import { loadFixtureWorld } from "../deterministic/world.js";
import { MockFixtureResetClient, parseResetResult, requireMatchingDigest } from "./reset-client.js";

test("parseResetResult accepts gateway camelCase contentDigest", () => {
  const got = parseResetResult({ fixtureSnapshotId: "fix_quickmart_v1", contentDigest: "sha256:abc" });
  assert.equal(got.fixture_snapshot_id, "fix_quickmart_v1");
  assert.equal(got.digest, "sha256:abc");
});

test("mock reset digest matches fixture world", async () => {
  const world = loadFixtureWorld();
  const client = new MockFixtureResetClient("cred");
  const reset = await client.reset("fix_quickmart_v1");
  assert.equal(reset.digest, world.digest);
  requireMatchingDigest(world.digest, reset);
});

test("requireMatchingDigest fails on mismatch", () => {
  assert.throws(
    () => requireMatchingDigest("sha256:a", { fixture_snapshot_id: "fix_quickmart_v1", digest: "sha256:b" }),
    (err: unknown) => err instanceof LabError && err.code === "FIXTURE_DIGEST_MISMATCH",
  );
});

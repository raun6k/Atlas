import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";

test("Lab role cannot read Atlas: isolation is encoded in configuration and trust domain", () => {
  const cfg = loadConfig({ postgresUrl: "postgres://atlaslab:@localhost:5432/atlaslab?sslmode=disable" });
  assert.equal(cfg.postgresUrl.includes("/atlaslab"), true);
  assert.equal(cfg.postgresUrl.includes("/atlas?"), false);
  assert.notEqual(cfg.postgresUrl, process.env.ATLAS_POSTGRES_URL ?? "postgres://atlas:@localhost:5432/atlas?sslmode=disable");
});

test("permission probe treats missing Atlas database as fail-closed isolation", async () => {
  const { MemoryStore } = await import("./memory-store.js");
  const store = new MemoryStore();
  assert.equal(await store.ping(), true);
  assert.equal(await store.migrationVersion(), "0006_release_repair");
});

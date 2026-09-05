import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMcpSchemas, publicInputSchema, validateToolArguments } from "./mcp-schemas.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tools = JSON.parse(readFileSync(join(root, "schemas/mcp/tools.json"), "utf8")).tools as string[];

test("gateway schemas match schemas/mcp for all public tools", () => {
  const loaded = loadMcpSchemas();
  assert.equal(tools.length, 13);
  for (const name of tools) {
    const schema = publicInputSchema(name);
    assert.equal(schema.type, "object");
    assert.ok(schema.properties);
    const disk = JSON.parse(readFileSync(join(root, `schemas/mcp/${name}.json`), "utf8"));
    assert.deepEqual(schema.properties, disk.properties);
    assert.deepEqual(schema.required, disk.required);
    assert.equal(schema.additionalProperties, disk.additionalProperties);
    assert.ok(loaded.has(name));
  }
});

test("create_session validates required fields and enums", () => {
  const miss = validateToolArguments("create_session", {});
  assert.equal(miss.ok, false);
  const ok = validateToolArguments("create_session", {
    subject_reference: "buyer-1",
    delivery_serviceability_reference: "blr_koramangala_5th_block",
  });
  assert.equal(ok.ok, true);
  const badEnum = validateToolArguments("create_session", {
    subject_reference: "buyer-1",
    delivery_serviceability_reference: "blr_koramangala_5th_block",
    evaluation_arm: "OTHER",
  });
  assert.equal(badEnum.ok, false);
});

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/lab/eval/route";

const keys = ["ATLAS_FRONTEND_ENABLE_MOCKS", "ATLASLAB_API_URL", "ATLASLAB_SERVICE_TOKEN"] as const;
const snapshot: Record<string, string | undefined> = {};

function restore() {
  for (const key of keys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(body: unknown) {
  return new NextRequest("http://127.0.0.1/api/lab/eval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("lab eval proxy", () => {
  beforeAll(() => {
    for (const key of keys) snapshot[key] = process.env[key];
  });
  afterEach(restore);

  it("rejects an unknown kind", async () => {
    const res = await POST(request({ kind: "nope" }));
    expect(res.status).toBe(400);
  });

  it("returns a fixture sitting when mocks are on", async () => {
    process.env.ATLAS_FRONTEND_ENABLE_MOCKS = "1";
    const res = await POST(request({ kind: "deterministic" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mock).toBe(true);
    expect(body.summary).toContain("fixture");
    expect(body.run.run_id).toBe("run_fixture_deterministic");
  });

  it("requires a prompt for custom missions", async () => {
    process.env.ATLAS_FRONTEND_ENABLE_MOCKS = "1";
    const res = await POST(request({ kind: "custom" }));
    expect(res.status).toBe(400);
  });

  it("fails closed when AtlasLab is not configured", async () => {
    process.env.ATLAS_FRONTEND_ENABLE_MOCKS = "0";
    delete process.env.ATLASLAB_API_URL;
    const res = await POST(request({ kind: "deterministic" }));
    expect(res.status).toBe(503);
  });
});

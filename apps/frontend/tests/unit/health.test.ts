import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as live } from "@/app/health/live/route";
import { GET as ready } from "@/app/health/ready/route";

const keys = [
  "ATLAS_ADMIN_API_URL",
  "ATLAS_ADMIN_SERVICE_TOKEN",
  "ATLASLAB_API_URL",
  "ATLASLAB_SERVICE_TOKEN",
  "ATLASLAB_API_TOKEN",
] as const;

const snapshot: Record<string, string | undefined> = {};

function restore() {
  for (const key of keys) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("health", () => {
  beforeAll(() => {
    for (const key of keys) {
      snapshot[key] = process.env[key];
    }
  });
  afterEach(restore);

  it("live always reports live", async () => {
    const res = live();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "live" });
  });

  it("ready requires both API credentials", async () => {
    delete process.env.ATLAS_ADMIN_API_URL;
    delete process.env.ATLAS_ADMIN_SERVICE_TOKEN;
    delete process.env.ATLASLAB_API_URL;
    delete process.env.ATLASLAB_SERVICE_TOKEN;
    delete process.env.ATLASLAB_API_TOKEN;

    const missing = await ready();
    expect(missing.status).toBe(503);

    process.env.ATLAS_ADMIN_API_URL = "http://127.0.0.1:8080";
    process.env.ATLAS_ADMIN_SERVICE_TOKEN = "admin";
    process.env.ATLASLAB_API_URL = "http://127.0.0.1:8090";
    process.env.ATLASLAB_SERVICE_TOKEN = "lab";

    const ok = await ready();
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ status: "ready" });
  });
});

export async function adminGet(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = process.env.ATLAS_ADMIN_API_URL ?? "";
  const token = process.env.ATLAS_ADMIN_SERVICE_TOKEN ?? "";
  const bearer = process.env.ATLAS_TEST_ADMIN_BEARER ?? "operator-test-bearer";
  if (!base) return { ok: false, status: 503, body: { code: "UNAVAILABLE", message: "ATLAS_ADMIN_API_URL unset" } };
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      "x-atlas-service-token": token,
      accept: "application/json",
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ code: "UNAVAILABLE" }));
  return { ok: res.ok, status: res.status, body };
}

export async function labGet(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = process.env.ATLASLAB_API_URL ?? "";
  const token = process.env.ATLASLAB_SERVICE_TOKEN || process.env.ATLASLAB_API_TOKEN || "";
  if (!base) return { ok: false, status: 503, body: { code: "UNAVAILABLE", message: "ATLASLAB_API_URL unset" } };
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ code: "UNAVAILABLE" }));
  return { ok: res.ok, status: res.status, body };
}

export function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function asList(body: unknown, keys: string[]): unknown[] {
  const rec = asRecord(body);
  for (const key of keys) {
    const v = rec[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

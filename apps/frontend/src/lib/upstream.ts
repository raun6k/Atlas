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

export async function labPost(
  path: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 240_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = process.env.ATLASLAB_API_URL ?? "";
  const token = process.env.ATLASLAB_SERVICE_TOKEN || process.env.ATLASLAB_API_TOKEN || "";
  if (!base) return { ok: false, status: 503, body: { error: { code: "UNAVAILABLE", message: "ATLASLAB_API_URL unset" } } };
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({ error: { code: "UNAVAILABLE", message: "AtlasLab returned a non-JSON body" } }));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (timedOut) {
      return { ok: false, status: 504, body: { error: { code: "EVAL_TIMEOUT", message: "AtlasLab eval timed out" } } };
    }
    return {
      ok: false,
      status: 503,
      body: { error: { code: "UNAVAILABLE", message: err instanceof Error ? err.message : "AtlasLab unavailable" } },
    };
  }
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

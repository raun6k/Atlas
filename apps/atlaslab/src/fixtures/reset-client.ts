import { LabError } from "../types.js";
import { loadFixtureWorld } from "../deterministic/world.js";

export interface FixtureResetResult {
  fixture_snapshot_id: string;
  digest: string;
}

export interface FixtureResetClient {
  reset(snapshotId: string): Promise<FixtureResetResult>;
  current(): Promise<FixtureResetResult>;
  /** Returns false when the Atlas fixture hook is missing (404) or refused. */
  invalidateInventory?(locationId: string, skuId: string): Promise<boolean>;
  paymentOutcome?(sessionId: string, outcome: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export function parseResetResult(body: unknown): FixtureResetResult {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const snapshot = String(rec.fixture_snapshot_id ?? rec.fixtureSnapshotId ?? "");
  const digest = String(rec.digest ?? rec.content_digest ?? rec.contentDigest ?? "");
  if (!digest) {
    throw new LabError("FIXTURE_DIGEST_MISMATCH", "fixture reset returned empty digest", 502);
  }
  return { fixture_snapshot_id: snapshot, digest };
}

export function requireMatchingDigest(worldDigest: string, reset: FixtureResetResult): void {
  if (!reset.digest || reset.digest !== worldDigest) {
    throw new LabError(
      "FIXTURE_DIGEST_MISMATCH",
      `core digest ${reset.digest} does not match oracle world ${worldDigest}`,
      409,
    );
  }
}

export class MockFixtureResetClient implements FixtureResetClient {
  private currentSnapshot = "fix_quickmart_v1";

  constructor(private readonly credential: string, private readonly onReset?: () => void) {}

  private pack(): FixtureResetResult {
    const world = loadFixtureWorld();
    return { fixture_snapshot_id: this.currentSnapshot || world.snapshot_id, digest: world.digest };
  }

  async reset(snapshotId: string): Promise<FixtureResetResult> {
    if (!this.credential) {
      throw new LabError("FIXTURE_CONTROL_REQUIRED", "fixture-reset credential missing", 403);
    }
    this.currentSnapshot = snapshotId || this.currentSnapshot;
    this.onReset?.();
    return this.pack();
  }

  async current(): Promise<FixtureResetResult> {
    return this.pack();
  }

  async invalidateInventory(_locationId: string, _skuId: string): Promise<boolean> {
    return false;
  }

  async paymentOutcome(_sessionId: string, outcome: string): Promise<Record<string, unknown>> {
    return { outcome, mock: true };
  }
}

export class HttpFixtureResetClient implements FixtureResetClient {
  constructor(
    private readonly atlasOrigin: string,
    private readonly credential: string,
  ) {}

  async reset(snapshotId: string): Promise<FixtureResetResult> {
    const res = await fetch(new URL("/test/v1/fixtures/reset", this.atlasOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.credential}`,
      },
      body: JSON.stringify({ fixture_snapshot_id: snapshotId }),
    });
    if (!res.ok) throw new LabError("FIXTURE_RESET_FAILED", `reset failed: ${res.status}`, 502);
    return parseResetResult(await res.json());
  }

  async current(): Promise<FixtureResetResult> {
    const res = await fetch(new URL("/test/v1/fixtures/current", this.atlasOrigin), {
      headers: { authorization: `Bearer ${this.credential}` },
    });
    if (!res.ok) throw new LabError("FIXTURE_RESET_FAILED", `current fixture failed: ${res.status}`, 502);
    return parseResetResult(await res.json());
  }

  async invalidateInventory(locationId: string, skuId: string): Promise<boolean> {
    const res = await fetch(new URL("/test/v1/fixtures/invalidate-inventory", this.atlasOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.credential}`,
      },
      body: JSON.stringify({ location_id: locationId, sku_id: skuId }),
    });
    if (res.status === 404) return false;
    return res.ok;
  }

  async paymentOutcome(sessionId: string, outcome: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await fetch(new URL("/test/v1/fixtures/payment-outcome", this.atlasOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.credential}`,
      },
      body: JSON.stringify({ session_id: sessionId, outcome }),
      signal,
    });
    if (!res.ok) throw new LabError("FIXTURE_RESET_FAILED", `payment fixture failed: ${res.status}`, 502);
    return (await res.json()) as Record<string, unknown>;
  }
}

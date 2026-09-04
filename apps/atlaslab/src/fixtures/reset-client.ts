import { sha256Hex } from "../ids.js";
import { LabError } from "../types.js";

export interface FixtureResetResult {
  fixture_snapshot_id: string;
  digest: string;
}

export interface FixtureResetClient {
  reset(snapshotId: string): Promise<FixtureResetResult>;
  current(): Promise<FixtureResetResult>;
}

export class MockFixtureResetClient implements FixtureResetClient {
  private currentSnapshot = "fix_quickmart_v1";
  readonly digest = "digest_fix_quickmart_v1_stable";

  constructor(private readonly credential: string, private readonly onReset?: () => void) {}

  async reset(snapshotId: string): Promise<FixtureResetResult> {
    if (!this.credential) {
      throw new LabError("FIXTURE_CONTROL_REQUIRED", "fixture-reset credential missing", 403);
    }
    this.currentSnapshot = snapshotId;
    this.onReset?.();
    return { fixture_snapshot_id: snapshotId, digest: this.digest };
  }

  async current(): Promise<FixtureResetResult> {
    return { fixture_snapshot_id: this.currentSnapshot, digest: this.digest };
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
    return (await res.json()) as FixtureResetResult;
  }

  async current(): Promise<FixtureResetResult> {
    const res = await fetch(new URL("/test/v1/fixtures/current", this.atlasOrigin), {
      headers: { authorization: `Bearer ${this.credential}` },
    });
    if (!res.ok) throw new LabError("FIXTURE_RESET_FAILED", `current fixture failed: ${res.status}`, 502);
    return (await res.json()) as FixtureResetResult;
  }
}

export function digestStableFromPayload(payload: unknown): string {
  return `digest_${sha256Hex(JSON.stringify(payload)).slice(0, 24)}`;
}

import { createHash, randomUUID } from "node:crypto";

export function newPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function utcNow(): string {
  return new Date().toISOString();
}

export function parseUsdToMicros(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(Math.round(value * 1_000_000))) {
      throw new Error("USD amount must be exact micros");
    }
    return Math.round(value * 1_000_000);
  }
  const [wholeRaw, frac = ""] = value.split(".");
  const whole = wholeRaw ?? "0";
  const fracPadded = (frac + "000000").slice(0, 6);
  const sign = whole.startsWith("-") ? -1 : 1;
  const absWhole = whole.replace("-", "") || "0";
  return sign * (Number.parseInt(absWhole, 10) * 1_000_000 + Number.parseInt(fracPadded, 10));
}

export function microsToUsdString(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "") || "0";
  return frac === "0" ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

export function assertIntegerMinor(amount: number, field: string): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`${field} must be a non-negative integer minor amount`);
  }
}

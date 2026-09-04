import { LabError } from "./types.js";

export const SECRET_CANARIES = {
  HOST_BEARER: "CANARY_HOST_BEARER_do_not_leak",
  HOST_SIGNING_KEY: "CANARY_HOST_SIGNING_KEY_do_not_leak",
  OPENROUTER: "CANARY_OPENROUTER_KEY_do_not_leak",
  FIXTURE_CONTROL: "CANARY_FIXTURE_CONTROL_do_not_leak",
  RAZORPAY: "CANARY_RAZORPAY_SECRET_do_not_leak",
} as const;

const CANARY_VALUES = Object.values(SECRET_CANARIES);

const SENSITIVE_KEY_PATTERN =
  /(bearer|authorization|signing[_-]?key|private[_-]?key|api[_-]?key|openrouter|razorpay|webhook[_-]?secret|fixture[_-]?control|password|jws|host_request_proof|checkout_authority)/i;

export function redactValue(value: string, extraSecrets: string[] = []): string {
  let out = value;
  for (const secret of [...CANARY_VALUES, ...extraSecrets.filter(Boolean)]) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function redactUnknown(value: unknown, extraSecrets: string[] = []): unknown {
  if (typeof value === "string") return redactValue(value, extraSecrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, extraSecrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactUnknown(v, extraSecrets);
      }
    }
    return out;
  }
  return value;
}

export function assertNoSecrets(payload: unknown, extraSecrets: string[] = []): void {
  const blob = JSON.stringify(payload);
  for (const secret of [...CANARY_VALUES, ...extraSecrets.filter(Boolean)]) {
    if (secret && blob.includes(secret)) {
      throw new LabError("SECRET_LEAK", "secret canary present in retained payload");
    }
  }
}

export function containsSecret(payload: unknown, extraSecrets: string[] = []): boolean {
  const blob = JSON.stringify(payload);
  return [...CANARY_VALUES, ...extraSecrets.filter(Boolean)].some((secret) => secret && blob.includes(secret));
}

export const REDACTION_REVISION = "redact_v1";

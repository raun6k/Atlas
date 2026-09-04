import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!secret || !signature) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.toLowerCase(), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function webhookEventId(headers: Record<string, string | string[] | undefined>): string {
  const v = headers["x-razorpay-event-id"] ?? headers["X-Razorpay-Event-Id"];
  if (Array.isArray(v)) {
    return v[0] ?? "";
  }
  return v ?? "";
}

export function webhookSignature(headers: Record<string, string | string[] | undefined>): string {
  const v = headers["x-razorpay-signature"] ?? headers["X-Razorpay-Signature"];
  if (Array.isArray(v)) {
    return v[0] ?? "";
  }
  return v ?? "";
}

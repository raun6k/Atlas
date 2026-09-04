import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { verifyRazorpayWebhookSignature, webhookEventId, webhookSignature } from "./verify.js";

export const RAZORPAY_WEBHOOK_PATH = "/providers/razorpay/webhooks";

export type WebhookCore = {
  ingestWebhook(input: { rawBody: Buffer; signature: string; eventId: string }): Promise<{ duplicate?: boolean } | void>;
};

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function handleRazorpayWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  core: WebhookCore,
): Promise<void> {
  const rawBody = await readRawBody(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const signature = webhookSignature(headers);
  const eventId = webhookEventId(headers);
  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ code: "PROVIDER_SIGNATURE_INVALID" }));
    return;
  }
  if (!eventId) {
    res.statusCode = 400;
    res.end(JSON.stringify({ code: "PROVIDER_EVENT_ID_MISSING" }));
    return;
  }
  try {
    const result = await core.ingestWebhook({ rawBody, signature, eventId });
    if (result && result.duplicate) {
      res.statusCode = 200;
      res.end(JSON.stringify({ code: "PROVIDER_EVENT_DUPLICATE", accepted: true }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ accepted: true, not_capture: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("PROVIDER_EVENT_DUPLICATE")) {
      res.statusCode = 200;
      res.end(JSON.stringify({ code: "PROVIDER_EVENT_DUPLICATE", accepted: true }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ code: "TEMPORARILY_UNAVAILABLE" }));
  }
}

/** Standalone listener for contract tests. Kernel mounts the same handler on NestJS with raw body. */
export function createWebhookServer(secret: string, core: WebhookCore) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === RAZORPAY_WEBHOOK_PATH) {
      void handleRazorpayWebhook(req, res, secret, core);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

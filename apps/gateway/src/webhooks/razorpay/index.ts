/**
 * NestJS mount note (Kernel owns the Gateway process):
 * 1. Disable JSON body parsing for POST /providers/razorpay/webhooks (raw body required).
 * 2. Call handleRazorpayWebhook from this package.
 * 3. Do not attach Host bearer middleware on this route (ID-002).
 */
export { handleRazorpayWebhook, createWebhookServer, RAZORPAY_WEBHOOK_PATH } from "./http.js";
export { verifyRazorpayWebhookSignature } from "./verify.js";

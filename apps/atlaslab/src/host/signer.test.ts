import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEphemeralHostSigner, signCheckoutAuthority, signHostRequestProof } from "./signer.js";
import { hostProofArguments } from "./boundary.js";
import { LabError, type ConsentPolicy } from "../types.js";
import { decodeJwt } from "jose";

const consent: ConsentPolicy = {
  max_amount_minor: 250000,
  currency: "INR",
  capability_id: "pcap_razorpay_test",
};

test("complete_checkout proof args match Core's hashed map", () => {
  assert.deepEqual(
    hostProofArguments("complete_checkout", {
      session_id: "ses_1",
      checkout_proposal_id: "cpo_1",
      checkout_proposal: { checkout_proposal_id: "cpo_1", quote_hash: "qh" },
      checkout_authority: "[REDACTED]",
    }),
    { session_id: "ses_1", checkout_proposal_id: "cpo_1" },
  );
});

test("Host Request Proof is compact ES256 JWS", async () => {
  const signer = generateEphemeralHostSigner();
  const jws = await signHostRequestProof({
    signer,
    requestId: "req_1",
    tool: "add_cart_item",
    args: { sku_id: "sku_qm_eggs_white_6", quantity: 1 },
    idempotencyKey: "idem_1",
    cartVersion: 0,
  });
  assert.match(jws, /^eyJ/);
  assert.equal(jws.split(".").length, 3);
  const claims = decodeJwt(jws);
  assert.equal(typeof claims.arg_digest, "string");
  assert.equal(claims.args_digest, undefined);
});

test("signer rejects amount above consent maximum", async () => {
  const signer = generateEphemeralHostSigner();
  await assert.rejects(
    () =>
      signCheckoutAuthority({
        signer,
        consent,
        proposal: {
          checkout_proposal_id: "cpo_1",
          session_id: "ses_1",
          session_context_version: 1,
          cart_id: "cart_1",
          cart_version: 1,
          quote_hash: "qh",
          final_amount_minor: 5000000,
          currency: "INR",
          payment_capability_id: "pcap_razorpay_test",
          status: "ACTIVE",
        },
        opaqueConsentRef: "consent_1",
      }),
    (err: unknown) => err instanceof LabError && err.code === "SIGNER_REJECTED",
  );
});

test("signer rejects missing quote hash", async () => {
  const signer = generateEphemeralHostSigner();
  await assert.rejects(
    () =>
      signCheckoutAuthority({
        signer,
        consent,
        proposal: {
          checkout_proposal_id: "cpo_1",
          session_id: "ses_1",
          session_context_version: 1,
          cart_id: "cart_1",
          cart_version: 1,
          quote_hash: "",
          final_amount_minor: 100,
          currency: "INR",
          payment_capability_id: "pcap_razorpay_test",
        },
        opaqueConsentRef: "consent_1",
      }),
    (err: unknown) => err instanceof LabError && err.code === "SIGNER_REJECTED",
  );
});

test("Checkout Authority uses Core's canonical amount_minor claim", async () => {
  const signer = generateEphemeralHostSigner();
  const jws = await signCheckoutAuthority({
    signer,
    consent,
    proposal: {
      checkout_proposal_id: "cpo_1",
      session_id: "ses_1",
      session_context_version: 1,
      cart_id: "cart_1",
      cart_version: 1,
      quote_hash: "qh",
      final_amount_minor: 16700,
      currency: "INR",
      payment_capability_id: "pcap_razorpay_test",
    },
    opaqueConsentRef: "consent_1",
  });
  const claims = decodeJwt(jws);
  assert.equal(claims.amount_minor, 16700);
  assert.equal(claims.final_amount_minor, undefined);
});

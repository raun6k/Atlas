import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "../canonical.js";
import { sha256Hex, utcNow } from "../ids.js";
import { LabError, type ConsentPolicy } from "../types.js";

const PROOF_TTL_SECONDS = 60;
const AUTHORITY_TTL_SECONDS = 120;
const AUDIENCE = "atlas.merchant.v1";

export interface HostSignerConfig {
  hostId: string;
  keyId: string;
  privateKey: KeyObject | Uint8Array;
  publicJwk: JWK;
}

export async function loadHostSigner(opts: {
  hostId: string;
  keyId: string;
  signingKeyPemOrJwk: string;
}): Promise<HostSignerConfig> {
  const raw = opts.signingKeyPemOrJwk.trim();
  let privateKey: KeyObject | Uint8Array;
  let publicJwk: JWK;
  if (raw.startsWith("{")) {
    const jwk = JSON.parse(raw) as JWK;
    privateKey = (await importJWK(jwk, "ES256")) as unknown as KeyObject;
    publicJwk = { ...jwk };
    delete (publicJwk as { d?: string }).d;
  } else {
    const keyObj = createPrivateKey(raw.includes("BEGIN") ? raw : `-----BEGIN PRIVATE KEY-----\n${raw}\n-----END PRIVATE KEY-----`);
    privateKey = keyObj;
    const pub = createPublicKey(keyObj);
    publicJwk = pub.export({ format: "jwk" }) as JWK;
  }
  return { hostId: opts.hostId, keyId: opts.keyId, privateKey, publicJwk };
}

export function generateEphemeralHostSigner(hostId = "host_atlaslab_quickmart", keyId = "lab_key_1"): HostSignerConfig {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    hostId,
    keyId,
    privateKey,
    publicJwk: publicKey.export({ format: "jwk" }) as JWK,
  };
}

export function argumentDigest(args: Record<string, unknown>): string {
  return sha256Hex(canonicalize(args));
}

export async function signHostRequestProof(opts: {
  signer: HostSignerConfig;
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  sessionContextVersion?: number;
  cartVersion?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.signer.hostId,
    kid: opts.signer.keyId,
    aud: AUDIENCE,
    iat: now,
    exp: now + PROOF_TTL_SECONDS,
    jti: `jti_${sha256Hex(`${opts.requestId}:${now}`).slice(0, 24)}`,
    request_id: opts.requestId,
    tool: opts.tool,
    session_context_version: opts.sessionContextVersion,
    cart_version: opts.cartVersion,
    idempotency_key: opts.idempotencyKey,
    // Core verifies the singular `arg_digest` claim. Keep this spelling aligned
    // with services/core/internal/trust/proof.go; a valid signature with a
    // differently named claim must fail closed.
    arg_digest: argumentDigest(opts.args),
  };
  return new CompactSign(Buffer.from(canonicalize(payload)))
    .setProtectedHeader({ alg: "ES256", kid: opts.signer.keyId, typ: "atlas.host_request_proof" })
    .sign(opts.signer.privateKey);
}

export async function signCheckoutAuthority(opts: {
  signer: HostSignerConfig;
  consent: ConsentPolicy;
  proposal: {
    checkout_proposal_id: string;
    merchant_profile_id?: string;
    session_id: string;
    session_context_version: number;
    cart_id: string;
    cart_version: number;
    quote_hash: string;
    final_amount_minor: number;
    currency: string;
    payment_capability_id: string;
    status?: string;
    expiry?: string;
  };
  opaqueConsentRef: string;
}): Promise<string> {
  const p = opts.proposal;
  if (!p.quote_hash) {
    throw new LabError("SIGNER_REJECTED", "missing exact quote hash");
  }
  if (p.currency !== opts.consent.currency) {
    throw new LabError("SIGNER_REJECTED", "unexpected currency");
  }
  if (p.payment_capability_id !== opts.consent.capability_id) {
    throw new LabError("SIGNER_REJECTED", "unexpected payment capability");
  }
  if (p.final_amount_minor > opts.consent.max_amount_minor) {
    throw new LabError("SIGNER_REJECTED", "amount exceeds consent maximum");
  }
  if (p.status && p.status !== "ACTIVE") {
    throw new LabError("SIGNER_REJECTED", "proposal is not active");
  }
  if (p.expiry && Date.parse(p.expiry) <= Date.now()) {
    throw new LabError("SIGNER_REJECTED", "proposal expired");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.signer.hostId,
    kid: opts.signer.keyId,
    aud: AUDIENCE,
    iat: now,
    exp: now + AUTHORITY_TTL_SECONDS,
    jti: `jti_${sha256Hex(`${p.checkout_proposal_id}:${now}`).slice(0, 24)}`,
    merchant_profile_id: p.merchant_profile_id ?? "mrc_quickmart",
    checkout_proposal_id: p.checkout_proposal_id,
    session_id: p.session_id,
    session_context_version: p.session_context_version,
    cart_id: p.cart_id,
    cart_version: p.cart_version,
    quote_hash: p.quote_hash,
    // Core's authority verifier binds the canonical money claim as
    // `amount_minor`; the CheckoutProposal field remains final_amount_minor.
    amount_minor: p.final_amount_minor,
    currency: p.currency,
    opaque_consent_ref: opts.opaqueConsentRef,
    payment_capability_id: "pcap_razorpay_test",
  };
  return new CompactSign(Buffer.from(canonicalize(payload)))
    .setProtectedHeader({ alg: "ES256", kid: opts.signer.keyId, typ: "atlas.checkout_authority" })
    .sign(opts.signer.privateKey);
}

export async function verifyCompact(token: string, signer: HostSignerConfig): Promise<void> {
  await compactVerify(token, signer.privateKey);
}

export function redactedProofPreview(_jws: string): string {
  return "[redacted host artifact]";
}

export function issuedAtIso(): string {
  return utcNow();
}

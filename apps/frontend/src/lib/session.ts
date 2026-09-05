import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "atlas_operator";

export interface OperatorSession {
  operator_id: string;
  email: string;
  exp: number;
}

function secret(): string {
  return process.env.ATLAS_FRONTEND_OPERATOR_SESSION_SECRET ?? "";
}

export function signSession(session: OperatorSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifySession(token: string): OperatorSession | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !secret()) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as OperatorSession;
    if (session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function readSession(): Promise<OperatorSession | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  return verifySession(raw);
}

export function sessionCookie(token: string) {
  return {
    name: COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.ATLAS_FRONTEND_SECURE_COOKIES === "1",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 12,
  };
}

export function clearCookie() {
  return {
    name: COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.ATLAS_FRONTEND_SECURE_COOKIES === "1",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}

export function authenticateOperator(email: string, password: string): OperatorSession | null {
  const merchantEmail = process.env.ATLAS_SEED_OPERATOR_MERCHANT_EMAIL ?? "merchant@quickmart.example";
  const evalEmail = process.env.ATLAS_SEED_OPERATOR_EVAL_EMAIL ?? "eval@quickmart.example";
  const merchantPass = process.env.ATLAS_SEED_OPERATOR_MERCHANT_PASSWORD ?? "";
  const evalPass = process.env.ATLAS_SEED_OPERATOR_EVAL_PASSWORD ?? "";
  const mocks = process.env.ATLAS_FRONTEND_ENABLE_MOCKS === "1";
  const okMerchant =
    email === merchantEmail &&
    ((merchantPass !== "" && password === merchantPass) || (mocks && password === "operator"));
  const okEval = email === evalEmail && (password === evalPass || (mocks && password === "operator"));
  if (!okMerchant && !okEval) return null;
  return {
    operator_id: okMerchant ? "op_merchant_quickmart" : "op_eval_quickmart",
    email,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

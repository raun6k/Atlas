import { NextResponse } from "next/server";
import { authenticateOperator, clearCookie, readSession, sessionCookie, signSession } from "@/lib/session";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const json = form ? null : ((await req.json().catch(() => ({}))) as { email?: string; password?: string });
  const email = String(form?.get("email") ?? json?.email ?? "");
  const password = String(form?.get("password") ?? json?.password ?? "");
  const session = authenticateOperator(email, password);
  if (!session) {
    return NextResponse.json({ error: "invalid operator credentials" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, operator_id: session.operator_id });
  const c = sessionCookie(signSession(session));
  res.cookies.set(c);
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  const c = clearCookie();
  res.cookies.set(c);
  return res;
}

export async function GET() {
  const session = await readSession();
  return NextResponse.json({
    authenticated: session !== null,
    ...(session ? { operator_id: session.operator_id, email: session.email } : {}),
  });
}

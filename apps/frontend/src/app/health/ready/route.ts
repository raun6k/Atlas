import { NextResponse } from "next/server";

export async function GET() {
  const secret = Boolean(process.env.ATLAS_FRONTEND_OPERATOR_SESSION_SECRET);
  const admin = Boolean(process.env.ATLAS_ADMIN_API_URL && process.env.ATLAS_ADMIN_SERVICE_TOKEN);
  const lab = Boolean(
    process.env.ATLASLAB_API_URL && (process.env.ATLASLAB_SERVICE_TOKEN || process.env.ATLASLAB_API_TOKEN),
  );
  const ready = secret && admin && lab;
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      session_secret_configured: secret,
      atlas_admin_configured: admin,
      atlaslab_configured: lab,
    },
    { status: ready ? 200 : 503 },
  );
}

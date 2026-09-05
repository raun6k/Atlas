import { NextResponse } from "next/server";
import { fixtureEvalResult, isEvalKind, labPayload, summarizeLabResult, evalPath } from "@/lib/eval-run";
import { asRecord, labPost } from "@/lib/upstream";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = asRecord(await req.json().catch(() => ({})));
  if (!isEvalKind(body.kind)) {
    return NextResponse.json(
      { error: { code: "INVALID_ARGUMENT", message: "kind must be deterministic, compatibility, commercial, or custom" } },
      { status: 400 },
    );
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (body.kind === "custom" && !prompt.trim()) {
    return NextResponse.json(
      { error: { code: "INVALID_ARGUMENT", message: "custom eval requires a prompt" } },
      { status: 400 },
    );
  }
  if (process.env.ATLAS_FRONTEND_ENABLE_MOCKS === "1") {
    const fixture = fixtureEvalResult(body.kind);
    return NextResponse.json({ ...fixture, summary: summarizeLabResult(fixture) }, { status: 201 });
  }
  const payload = labPayload(body.kind, prompt);
  const timeoutMs = body.kind === "deterministic" ? 90_000 : 270_000;
  const result = await labPost(evalPath(body.kind), payload, timeoutMs);
  const responseBody = asRecord(result.body);
  if (result.status === 504) {
    return NextResponse.json(
      {
        error: {
          code: "EVAL_TIMEOUT",
          message: "Timed out waiting for AtlasLab. Compatibility and commercial evals can take several minutes; the lab may still be running.",
        },
      },
      { status: 504 },
    );
  }
  if (!result.ok) {
    return NextResponse.json(responseBody, { status: result.status });
  }
  return NextResponse.json(
    { ...responseBody, summary: summarizeLabResult(responseBody) },
    { status: result.status || 201 },
  );
}

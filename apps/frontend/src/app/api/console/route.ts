import { NextResponse } from "next/server";
import { readSession } from "@/lib/session";
import { loadScreen, type Screen } from "@/lib/console";

export async function GET(req: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const url = new URL(req.url);
  const screen = (url.searchParams.get("screen") ?? "home") as Screen;
  const data = await loadScreen(screen);
  return NextResponse.json(data);
}

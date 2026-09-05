import { NextResponse } from "next/server";
import { loadDashboard } from "@/lib/console";

export async function GET() {
  const data = await loadDashboard();
  return NextResponse.json(data);
}

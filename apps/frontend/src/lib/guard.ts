import { redirect } from "next/navigation";
import { readSession } from "./session";

export async function requireOperator() {
  const session = await readSession();
  if (!session) redirect("/login");
  return session;
}

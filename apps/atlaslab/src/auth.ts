import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AtlasLabConfig } from "./config.js";

export type AuthDecision = "ok" | "unauthorized" | "forbidden" | "read_only";

function equalToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(b.length);
    timingSafeEqual(dummy, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerToken(req: IncomingMessage): string {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length);
}

export function authorizeLab(req: IncomingMessage, cfg: Pick<AtlasLabConfig, "mode" | "apiReadToken" | "apiWriteToken">, mutating: boolean): AuthDecision {
  const token = bearerToken(req);
  const write = cfg.apiWriteToken;
  const read = cfg.apiReadToken;
  if (cfg.mode === "release" && (!write || !read)) {
    return "unauthorized";
  }
  if (!write && !read) {
    return token ? "ok" : mutating ? "unauthorized" : "ok";
  }
  if (!token) return "unauthorized";
  if (write && equalToken(token, write)) return "ok";
  if (read && equalToken(token, read)) return mutating ? "read_only" : "ok";
  return "forbidden";
}

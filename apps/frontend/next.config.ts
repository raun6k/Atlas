import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const monorepoRoot = resolve(process.cwd(), "../..");
const outputFileTracingRoot = existsSync(resolve(monorepoRoot, "package-lock.json"))
  ? monorepoRoot
  : process.cwd();

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot,
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  serverExternalPackages: [],
  async redirects() {
    return ["login", "sellability", "growth", "commerce", "merchant", "trust", "system", "demo"].map((route) => ({
      source: `/${route}`,
      destination: "/",
      permanent: false,
    }));
  },
  env: {
    // Only non-secret display defaults may be inlined. Secrets stay in server env.
    NEXT_PUBLIC_ATLAS_LOCALE: process.env.ATLAS_FRONTEND_LOCALE ?? "en-IN",
    NEXT_PUBLIC_ATLAS_TIMEZONE: process.env.ATLAS_FRONTEND_TIMEZONE ?? "Asia/Kolkata",
  },
};

export default nextConfig;

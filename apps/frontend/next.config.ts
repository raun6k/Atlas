import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: [],
  env: {
    // Only non-secret display defaults may be inlined. Secrets stay in server env.
    NEXT_PUBLIC_ATLAS_LOCALE: process.env.ATLAS_FRONTEND_LOCALE ?? "en-IN",
    NEXT_PUBLIC_ATLAS_TIMEZONE: process.env.ATLAS_FRONTEND_TIMEZONE ?? "Asia/Kolkata",
  },
};

export default nextConfig;

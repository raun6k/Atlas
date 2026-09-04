#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const canaries = [
  process.env.ATLAS_ADMIN_SERVICE_TOKEN ?? "canary-admin-token-DO-NOT-LEAK-xyz",
  process.env.ATLASLAB_SERVICE_TOKEN ?? "canary-lab-token-DO-NOT-LEAK-abc",
  process.env.ATLAS_FRONTEND_OPERATOR_SESSION_SECRET ?? "test-session-secret-32chars-minimum!!",
  process.env.ATLAS_SEED_OPERATOR_MERCHANT_PASSWORD ?? "test-merchant-pass",
];

const nextDir = path.join(root, ".next");
if (!existsSync(nextDir)) {
  const build = spawnSync("npx", ["next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ATLAS_ADMIN_API_URL: "http://127.0.0.1:18080",
      ATLASLAB_API_URL: "http://127.0.0.1:18080",
      ATLAS_FRONTEND_OPERATOR_SESSION_SECRET: canaries[2],
      ATLAS_ADMIN_SERVICE_TOKEN: canaries[0],
      ATLASLAB_SERVICE_TOKEN: canaries[1],
    },
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const scanRoots = [path.join(nextDir, "static")].filter(existsSync);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = scanRoots.flatMap(walk);
const hits = [];
for (const file of files) {
  if (!/\.(js|css|html|json|txt)$/.test(file)) {
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const canary of canaries) {
    if (canary && text.includes(canary)) {
      hits.push({ file, canary: canary.slice(0, 12) });
    }
  }
}

if (hits.length) {
  console.error("Secret canary leaked into client/server assets:", hits);
  process.exit(1);
}

console.log(`secret-scan ok (${files.length} files, ${canaries.length} canaries)`);

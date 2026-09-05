#!/usr/bin/env node
/**
 * Database permission test: Atlas role cannot read AtlasLab, and vice versa.
 */
import { execFileSync } from "node:child_process";

function tryPs(url, sql) {
  try {
    execFileSync("psql", [url, "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message || err) };
  }
}

function pgUrl(raw, fallback) {
  return new URL(raw || fallback);
}

function connectUrl(u, user, password, db) {
  const out = new URL(u.toString());
  out.username = user;
  out.password = password;
  out.pathname = `/${db}`;
  return out.toString();
}

const atlas = pgUrl(process.env.ATLAS_POSTGRES_URL, "postgres://atlas:atlas@127.0.0.1:5432/atlas?sslmode=disable");
const lab = pgUrl(process.env.ATLASLAB_POSTGRES_URL, "postgres://atlaslab:atlaslab@127.0.0.1:5433/atlaslab?sslmode=disable");
const endpoint = (u) => `${u.hostname}:${u.port || "5432"}${u.pathname}`;
console.log(`permission test endpoints: atlas=${endpoint(atlas)} atlaslab=${endpoint(lab)}`);

const atlasSelf = tryPs(connectUrl(atlas, "atlas", "atlas", "atlas"), "SELECT 1");
const labSelf = tryPs(connectUrl(lab, "atlaslab", "atlaslab", "atlaslab"), "SELECT 1");
if (!atlasSelf.ok || !labSelf.ok) {
  console.error("FAIL: permission test requires both databases; use join-permission-soft for unit-only runs");
  process.exit(1);
}

const atlasReadsLab = tryPs(connectUrl(lab, "atlas", "atlas", "atlaslab"), "SELECT 1");
const labReadsAtlas = tryPs(connectUrl(atlas, "atlaslab", "atlaslab", "atlas"), "SELECT 1");

if (atlasReadsLab.ok) {
  console.error("FAIL: atlas role was able to read atlaslab");
  process.exit(1);
}
if (labReadsAtlas.ok) {
  console.error("FAIL: atlaslab role was able to read atlas");
  process.exit(1);
}
console.log("permission test ok: each role cannot read the other database");

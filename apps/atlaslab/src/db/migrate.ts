import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  const candidates = [
    join(here, "../../../../db/atlaslab/migrations"),
    join(here, "../../../db/atlaslab/migrations"),
    join(process.cwd(), "db/atlaslab/migrations"),
    join(process.cwd(), "../../db/atlaslab/migrations"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export async function applyMigrations(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query(sql);
      applied.push(file);
    }
    const rolesDir = join(dir, "../roles");
    for (const file of ["atlaslab_app.sql", "permission_probe.sql"]) {
      try {
        await client.query(readFileSync(join(rolesDir, file), "utf8"));
      } catch {
        // role SQL may fail on limited test users; permission tests cover isolation.
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.ATLASLAB_POSTGRES_URL;
  if (!url) {
    console.log("ATLASLAB_POSTGRES_URL unset; skipping migrate");
    process.exit(0);
  }
  applyMigrations(url).then((applied) => {
    console.log(`applied ${applied.join(", ")}`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

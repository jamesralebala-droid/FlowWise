import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface Row {
  [k: string]: unknown;
}

/** Minimal SQL executor that can run multi-statement scripts (simple protocol). */
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function runMigrations(exec: SqlExecutor): Promise<string[]> {
  await exec.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await exec.query("SELECT name FROM schema_migrations")).rows.map((r) => String(r.name)));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await exec.exec(sql);
    await exec.exec(`INSERT INTO schema_migrations (name, checksum) VALUES ('${file}', '${checksum}')`);
    ran.push(file);
  }
  return ran;
}

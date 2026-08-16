import { Pool } from "pg";
import { env } from "../env.js";
import { runMigrations } from "./migrations.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    console.error("DATABASE_URL is required for CLI migrations. (Embedded PGlite auto-migrates on boot.)");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: env.databaseUrl });
  try {
    const applied = await runMigrations({
      exec: (sql) => pool.query(sql),
      query: (text, params) => pool.query(text, params),
    });
    console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "No pending migrations.");
  } finally {
    await pool.end();
  }
}

void main();

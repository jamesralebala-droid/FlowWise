import { Pool } from "pg";
import { env } from "../env.js";
import { hashPassword } from "../password.js";
import { runMigrations } from "./migrations.js";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    console.error("seed:dev requires DATABASE_URL (run it against your local PostgreSQL as the migrator role).");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: env.databaseUrl });
  const client = await pool.connect();
  try {
    await runMigrations({
      exec: (sql) => client.query(sql),
      query: (text, params) => client.query(text, params),
    });

    const org = await client.query(
      `INSERT INTO organisations (name, slug, currency_code, timezone, vat_rate)
       VALUES ('BotWise Demo', 'botwise-demo', 'BWP', 'Africa/Gaborone', 0.1400)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    const orgId = org.rows[0].id as string;

    const branch = await client.query(
      `INSERT INTO branches (org_id, name, code)
       VALUES ($1, 'Main Branch', 'MAIN')
       ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId],
    );
    const branchId = branch.rows[0].id as string;

    const passwordHash = await hashPassword("Password123!");
    const demoUsers = [
      { email: "owner@flowwise.demo", name: "Demo Owner", role: "owner" },
      { email: "cashier@flowwise.demo", name: "Demo Cashier", role: "cashier" },
      { email: "stock@flowwise.demo", name: "Demo Stock Controller", role: "stock_controller" },
      { email: "auditor@flowwise.demo", name: "Demo Auditor", role: "auditor" },
    ];
    for (const u of demoUsers) {
      await client.query(
        `INSERT INTO users (org_id, email, name, password_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, email) DO UPDATE SET name = EXCLUDED.name`,
        [orgId, u.email, u.name, passwordHash],
      );
      await client.query(
        `INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code)
         SELECT $1, id, $4, $3 FROM users WHERE org_id = $1 AND email = $2
         ON CONFLICT (org_id, user_id, branch_id, role_code) DO NOTHING`,
        [orgId, u.email, u.role, u.role === "owner" ? null : branchId],
      );
    }

    await client.query(
      `INSERT INTO oauth_clients (client_id, name, redirect_uris)
       VALUES ('flowwise-app', 'FlowWise Android', '[]'::jsonb)
       ON CONFLICT (client_id) DO NOTHING`,
    );

    console.log(
      `Seeded demo org ${orgId} with branch ${branchId}\n` +
        `Logins (password "Password123!"): owner@flowwise.demo, cashier@flowwise.demo, ` +
        `stock@flowwise.demo, auditor@flowwise.demo`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

void main();

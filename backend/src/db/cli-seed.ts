import { Pool } from "pg";
import { env } from "../env.js";
import { hashPassword } from "../password.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";

const ORG_NAME = "BotWise Demo";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    console.error("seed:dev requires DATABASE_URL (run it against your local PostgreSQL as the migrator role).");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: env.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await runMigrations({
        exec: (sql) => client.query(sql),
        query: (text, params) => client.query(text, params),
      });
      const passwordHash = await hashPassword("Password123!");
      const result = await seedDemoData(
        {
          exec: (sql) => client.query(sql),
          query: (text, params) => client.query(text, params),
        },
        passwordHash,
      );
      await client.query("COMMIT");

      const branchLine = result.branches.map((b) => `${b.code} (${b.name})`).join(", ");
      console.log(
        `Seeded demo organisation "${ORG_NAME}" (${result.orgId})\n` +
          `  Branches:        ${branchLine}\n` +
          `  Catalogue:       ${result.products} products / ${result.variants} variants / ${result.barcodes} barcodes / ${result.prices} prices\n` +
          `  Suppliers:       ${result.suppliers}\n` +
          `  Opening ledger:  ${result.openingLedgerRows} movements (movement_type 'opening')\n` +
          `  Reorder rules:   ${result.reorderRules}\n` +
          `  Promotions:      ${result.promotions} (WELCOME10, P50OFF, MONTHEND5)\n` +
          `  Customers:       ${result.customers} (1 with a credit limit + opening balance)\n` +
          `  Demo users:      ${result.users} (password "Password123!")\n` +
          `  OAuth client:    flowwise-app\n` +
          `\nDemo logins: owner@, manager@, cashier@, cashier2@, stock@, auditor@flowwise.demo\n` +
          `A reorder evaluation on MAIN will show GRO-001 (maize meal) below its reorder point.`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main();

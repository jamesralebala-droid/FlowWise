import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, type Row } from "../src/db/migrations.js";
import { PGliteDb, type Db } from "../src/db/db.js";
import { hashPassword } from "../src/password.js";

export interface Fixtures {
  db: Db;
  raw: PGlite;
  orgA: string;
  orgB: string;
  branchA1: string;
  branchA2: string;
  branchB1: string;
  ownerA: string;
  cashierA: string;
  auditorA: string;
  ownerB: string;
  stockA: string;
  variantA: string;
  variantB: string;
  /** Phase 3 test-scoped: supplier + PO created across tests in procurement.test.ts */
  supplierId?: string;
  poId?: string;
}

async function insertReturning(raw: PGlite, sql: string): Promise<string> {
  const r = await raw.query<{ id: string }>(sql);
  return r.rows[0].id;
}

async function insertUser(raw: PGlite, orgId: string, email: string, name: string, passwordHash: string): Promise<string> {
  return insertReturning(
    raw,
    `INSERT INTO users (org_id, email, name, password_hash) VALUES ('${orgId}', '${email}', '${name}', '${passwordHash}') RETURNING id`,
  );
}

/**
 * Boots an isolated embedded PostgreSQL, applies all migrations as the
 * superuser owner, creates the RLS-enforced app role, seeds two organisations
 * (org A = victim, org B = attacker) plus a catalogue for org A, then switches
 * the session to the app role so every query runs under RLS.
 */
export async function createTestDb(): Promise<Fixtures> {
  const raw = new PGlite();

  await runMigrations({
    exec: (sql) => raw.exec(sql),
    query: async (text, params) => {
      const r = await raw.query<Record<string, unknown>>(text, params ?? []);
      return { rows: r.rows as Row[] };
    },
  });

  await raw.exec("CREATE ROLE flowwise_app NOLOGIN");
  await raw.exec("GRANT USAGE ON SCHEMA public TO flowwise_app");
  await raw.exec("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowwise_app");
  await raw.exec("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowwise_app");

  const orgA = await insertReturning(raw, `INSERT INTO organisations (name, slug) VALUES ('BotWise Demo', 'botwise-demo') RETURNING id`);
  const orgB = await insertReturning(raw, `INSERT INTO organisations (name, slug) VALUES ('Evil Corp', 'evil-corp') RETURNING id`);

  const branchA1 = await insertReturning(raw, `INSERT INTO branches (org_id, name, code) VALUES ('${orgA}', 'Main Branch', 'MAIN') RETURNING id`);
  const branchA2 = await insertReturning(raw, `INSERT INTO branches (org_id, name, code) VALUES ('${orgA}', 'Francistown', 'FRA') RETURNING id`);
  const branchB1 = await insertReturning(raw, `INSERT INTO branches (org_id, name, code) VALUES ('${orgB}', 'Only Branch', 'B1') RETURNING id`);

  const pw = await hashPassword("Password123!");
  const ownerA = await insertUser(raw, orgA, "owner@flowwise.demo", "Demo Owner", pw);
  const cashierA = await insertUser(raw, orgA, "cashier@flowwise.demo", "Demo Cashier", pw);
  const auditorA = await insertUser(raw, orgA, "auditor@flowwise.demo", "Demo Auditor", pw);
  const ownerB = await insertUser(raw, orgB, "boss@evilcorp.test", "Evil Boss", pw);
  const stockA = await insertUser(raw, orgA, "stock@flowwise.demo", "Demo Stock Controller", pw);

  await raw.exec(`INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code) VALUES ('${orgA}', '${ownerA}', NULL, 'owner')`);
  await raw.exec(`INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code) VALUES ('${orgA}', '${cashierA}', '${branchA1}', 'cashier')`);
  await raw.exec(`INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code) VALUES ('${orgA}', '${auditorA}', '${branchA1}', 'auditor')`);
  await raw.exec(`INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code) VALUES ('${orgA}', '${stockA}', '${branchA1}', 'stock_controller')`);
  await raw.exec(`INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code) VALUES ('${orgB}', '${ownerB}', NULL, 'owner')`);

  await raw.exec(`INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES ('flowwise-app', 'FlowWise Android', '[]'::jsonb)`);

  // Org A catalogue (Phase 0 exit fixture)
  const cat = await insertReturning(raw, `INSERT INTO categories (org_id, name) VALUES ('${orgA}', 'Drinks') RETURNING id`);
  const uom = await insertReturning(raw, `INSERT INTO units_of_measure (org_id, code, name) VALUES ('${orgA}', 'EA', 'Each') RETURNING id`);
  const tax = await insertReturning(raw, `INSERT INTO taxes (org_id, name, rate) VALUES ('${orgA}', 'VAT', 0.1400) RETURNING id`);
  const prod1 = await insertReturning(raw, `INSERT INTO products (org_id, category_id, uom_id, name, sku) VALUES ('${orgA}', '${cat}', '${uom}', 'Coca-Cola', 'SKU-001') RETURNING id`);
  const prod2 = await insertReturning(raw, `INSERT INTO products (org_id, category_id, uom_id, name, sku) VALUES ('${orgA}', '${cat}', '${uom}', 'Fanta Orange', 'SKU-002') RETURNING id`);
  const variantA = await insertReturning(raw, `INSERT INTO product_variants (org_id, product_id, name, sku) VALUES ('${orgA}', '${prod1}', '330ml', 'SKU-001-330') RETURNING id`);
  const variantB = await insertReturning(raw, `INSERT INTO product_variants (org_id, product_id, name, sku) VALUES ('${orgA}', '${prod2}', '500ml', 'SKU-002-500') RETURNING id`);
  await raw.exec(`INSERT INTO barcodes (org_id, variant_id, barcode) VALUES ('${orgA}', '${variantA}', '6001234567890')`);
  const pl = await insertReturning(raw, `INSERT INTO price_lists (org_id, name, is_default) VALUES ('${orgA}', 'Default', true) RETURNING id`);
  await raw.exec(`INSERT INTO price_list_items (org_id, price_list_id, variant_id, price) VALUES ('${orgA}', '${pl}', '${variantA}', 7.5000), ('${orgA}', '${pl}', '${variantB}', 9.0000)`);

  // Phase 2 fixture: variantB is a reorder-configured item (low-stock alerts).
  await raw.exec(`UPDATE product_variants SET reorder_level = 10, reorder_quantity = 24 WHERE id = '${variantB}'`);

  // From here on every query runs as the RLS-enforced app role.
  await raw.exec("SET ROLE flowwise_app");

  void tax;
  void branchB1;

  return {
    db: new PGliteDb(raw),
    raw,
    orgA,
    orgB,
    branchA1,
    branchA2,
    branchB1,
    ownerA,
    cashierA,
    auditorA,
    ownerB,
    stockA,
    variantA,
    variantB,
  };
}

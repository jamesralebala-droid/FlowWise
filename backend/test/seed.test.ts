import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, type Row, type SqlExecutor } from "../src/db/migrations.js";
import { seedDemoData } from "../src/db/seed.js";
import { hashPassword } from "../src/password.js";

describe("seed:dev demo data (multi-branch pilot fixture)", () => {
  let raw: PGlite;
  let exec: SqlExecutor;
  let orgId: string;
  let branchIds: Record<string, string>;
  let firstRun: Awaited<ReturnType<typeof seedDemoData>>;

  beforeAll(async () => {
    raw = new PGlite();
    exec = {
      exec: (sql) => raw.exec(sql),
      query: async (text, params) => {
        const r = await raw.query<Row>(text, params ?? []);
        return { rows: r.rows };
      },
    };
    await runMigrations(exec);

    const passwordHash = await hashPassword("Password123!");
    firstRun = await seedDemoData(exec, passwordHash);
    orgId = firstRun.orgId;

    const branches = await raw.query<Row>("SELECT code, id FROM branches WHERE org_id = $1", [orgId]);
    branchIds = Object.fromEntries(branches.rows.map((b) => [b.code as string, b.id as string]));
  });
  afterAll(async () => {
    await raw.close();
  });

  async function q(sql: string, params?: unknown[]): Promise<Row[]> {
    const r = await raw.query<Row>(sql, params ?? []);
    return r.rows;
  }

  it("creates the demo org with Botswana defaults and two branches", async () => {
    const org = await q("SELECT * FROM organisations WHERE id = $1", [orgId]);
    expect(org).toHaveLength(1);
    expect(org[0].slug).toBe("botwise-demo");
    expect(org[0].currency_code).toBe("BWP");
    expect(org[0].timezone).toBe("Africa/Gaborone");
    expect(org[0].vat_rate).toBe("0.1400");

    expect(firstRun.branches.map((b) => b.code).sort()).toEqual(["MAIN", "PHK"]);
    expect(Object.keys(branchIds).sort()).toEqual(["MAIN", "PHK"]);
  });

  it("seeds a realistic catalogue with prices, barcodes and suppliers", async () => {
    expect(firstRun.products).toBe(16);
    expect(firstRun.variants).toBe(16);
    expect(firstRun.barcodes).toBe(16);
    expect(firstRun.prices).toBe(16);
    expect(firstRun.suppliers).toBe(4);

    const prices = await q(
      `SELECT v.sku, pli.price::text AS price FROM price_list_items pli
       JOIN price_lists pl ON pl.id = pli.price_list_id
       JOIN product_variants v ON v.id = pli.variant_id
       WHERE pl.org_id = $1 AND pl.is_default`,
      [orgId],
    );
    expect(prices).toHaveLength(16);
    const coke = prices.find((p) => p.sku === "BEV-001");
    expect(coke?.price).toBe("8.5000");

    const supplierProducts = await q(
      `SELECT s.code, count(*)::int AS n FROM supplier_products sp
       JOIN suppliers s ON s.id = sp.supplier_id
       WHERE sp.org_id = $1 GROUP BY s.code ORDER BY s.code`,
      [orgId],
    );
    const byCode = Object.fromEntries(supplierProducts.map((r) => [r.code, r.n]));
    expect(byCode["BBV"]).toBe(4); // beverages
    expect(byCode["FRESHMARK"]).toBe(6); // maize, rice, sugar, oil, milk, salt
    expect(byCode["CHOPPIES"]).toBe(5);
    expect(byCode["SEFALANA"]).toBe(1);
  });

  it("writes opening balances through the ledger and reconciles (delta = 0)", async () => {
    expect(firstRun.openingLedgerRows).toBe(32); // 16 items × 2 branches

    const movementTypes = await q(
      `SELECT movement_type, count(*)::int AS n FROM stock_ledger WHERE org_id = $1 GROUP BY movement_type`,
      [orgId],
    );
    expect(movementTypes).toEqual([{ movement_type: "opening", n: 32 }]);

    const reconciles = await q(
      `SELECT variant_id, branch_id, ledger_quantity, inventory_quantity, delta
       FROM v_stock_reconciliation WHERE org_id = $1`,
      [orgId],
    );
    expect(reconciles).toHaveLength(32);
    for (const r of reconciles) {
      expect(r.delta).toBe("0.0000");
    }

    // MAIZE (GRO-001) MAIN is deliberately below its reorder point.
    const maize = await q(
      `SELECT ii.quantity_on_hand::text AS qoh, ii.branch_id
       FROM inventory_items ii
       JOIN product_variants v ON v.id = ii.variant_id
       WHERE ii.org_id = $1 AND v.sku = 'GRO-001' AND ii.branch_id = $2`,
      [orgId, branchIds["MAIN"]],
    );
    expect(maize[0].qoh).toBe("18.0000");
  });

  it("creates phase 5 demo customers with a receivable and credit limit", async () => {
    expect(firstRun.customers).toBe(2);
    expect(firstRun.customerOpeningRows).toBe(1);

    const customers = await q(
      `SELECT c.email, c.credit_limit::text AS "creditLimit", COALESCE(b.balance, 0)::numeric(14,4)::text AS balance
       FROM customers c
       LEFT JOIN v_customer_balances b ON b.customer_id = c.id AND b.org_id = c.org_id
       WHERE c.org_id = $1 ORDER BY c.name`,
      [orgId],
    );
    expect(customers).toHaveLength(2);
    const lodge = customers.find((c) => c.email === "accounts@maunlodge.test");
    expect(lodge?.creditLimit).toBe("5000.0000");
    expect(lodge?.balance).toBe("850.0000");
    const walkIn = customers.find((c) => c.email === "kelebogile@example.test");
    expect(walkIn?.creditLimit).toBe("0.0000");
    expect(walkIn?.balance).toBe("0.0000");
  });

  it("creates per-branch reorder rules and demo users with correct scopes", async () => {
    expect(firstRun.reorderRules).toBe(32);

    const rules = await q(
      `SELECT count(*)::int AS n FROM reorder_rules rr
       JOIN product_variants v ON v.id = rr.variant_id
       WHERE rr.org_id = $1 AND v.sku = 'GRO-001'`,
      [orgId],
    );
    expect(rules[0].n).toBe(2); // one rule per branch

    expect(firstRun.users).toBe(6);

    // owner: org-wide; manager: both branches; cashiers: one branch each.
    const ownerScope = await q(
      `SELECT count(*)::int AS n FROM user_role_assignments
       WHERE org_id = $1 AND role_code = 'owner' AND branch_id IS NULL`,
      [orgId],
    );
    expect(ownerScope[0].n).toBe(1);

    const managerBranches = await q(
      `SELECT count(*)::int AS n FROM user_role_assignments
       WHERE org_id = $1 AND role_code = 'branch_manager'`,
      [orgId],
    );
    expect(managerBranches[0].n).toBe(2);

    const cashierPhk = await q(
      `SELECT u.email FROM user_role_assignments ura
       JOIN users u ON u.id = ura.user_id
       WHERE ura.org_id = $1 AND ura.role_code = 'cashier' AND ura.branch_id = $2`,
      [orgId, branchIds["PHK"]],
    );
    expect(cashierPhk.map((r) => r.email)).toEqual(["cashier2@flowwise.demo"]);

    const oauth = await q("SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = 'flowwise-app'");
    expect(oauth[0].n).toBe(1);
  });

  it("is fully idempotent — re-running never duplicates anything", async () => {
    const passwordHash = await hashPassword("Password123!");
    const rerun = await seedDemoData(exec, passwordHash);

    // No new catalogue, no new ledger movements, no new rules, no new customers.
    expect(rerun.products).toBe(16);
    expect(rerun.openingLedgerRows).toBe(0);
    expect(rerun.reorderRules).toBe(32);
    expect(rerun.customers).toBe(2);
    expect(rerun.customerOpeningRows).toBe(0);

    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM products WHERE org_id = $1) AS products,
         (SELECT count(*)::int FROM product_variants WHERE org_id = $1) AS variants,
         (SELECT count(*)::int FROM stock_ledger WHERE org_id = $1) AS ledger,
         (SELECT count(*)::int FROM inventory_items WHERE org_id = $1) AS inventory,
         (SELECT count(*)::int FROM reorder_rules WHERE org_id = $1) AS rules,
         (SELECT count(*)::int FROM user_role_assignments WHERE org_id = $1) AS assignments,
         (SELECT count(*)::int FROM users WHERE org_id = $1) AS users`,
      [orgId],
    );
    const c = counts[0];
    expect(c.products).toBe(16);
    expect(c.variants).toBe(16);
    expect(c.ledger).toBe(32);
    expect(c.inventory).toBe(32);
    expect(c.rules).toBe(32);
    expect(c.assignments).toBe(8); // 1 owner + 2 manager + 2 cashiers + 2 stock + 1 auditor
    expect(c.users).toBe(6);
  });
});

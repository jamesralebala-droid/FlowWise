import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDb, type Fixtures } from "./setup.js";

describe("stock ledger invariants (Migration 003)", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await createTestDb();
  });
  afterAll(async () => {
    await fx.db.close();
  });

  const ctx = () => ({ orgId: fx.orgA, userId: fx.ownerA, deviceId: null });

  it("post 10,000 mixed movements → inventory_items equals the ledger sum", async () => {
    await fx.db.withContext(ctx(), (tx) =>
      tx.exec(
        `INSERT INTO stock_ledger (org_id, branch_id, variant_id, movement_type, quantity, reference_type, reference_id, idempotency_key)
         SELECT '${fx.orgA}'::uuid,
                CASE WHEN g % 2 = 0 THEN '${fx.branchA1}'::uuid ELSE '${fx.branchA2}'::uuid END,
                CASE WHEN g % 3 = 0 THEN '${fx.variantA}'::uuid ELSE '${fx.variantB}'::uuid END,
                CASE g % 4 WHEN 0 THEN 'sale'::movement_type
                           WHEN 1 THEN 'grn'::movement_type
                           WHEN 2 THEN 'adjustment'::movement_type
                           ELSE 'transfer_out'::movement_type END,
                ((g % 4 = 1)::int * 2 - 1) * (g % 9 + 1),
                'sale', NULL, 'ledger-' || g
         FROM generate_series(1, 10000) AS g`,
      ),
    );

    const sums = await fx.db.withContext(ctx(), (tx) =>
      tx.query(
        `SELECT branch_id, variant_id, SUM(quantity)::numeric(14,4) AS total
         FROM stock_ledger WHERE org_id = $1 GROUP BY branch_id, variant_id`,
        [fx.orgA],
      ),
    );
    const balances = await fx.db.withContext(ctx(), (tx) =>
      tx.query(
        `SELECT branch_id, variant_id, quantity_on_hand FROM inventory_items WHERE org_id = $1`,
        [fx.orgA],
      ),
    );

    expect(sums.rows.length).toBe(4); // 2 branches × 2 variants
    expect(balances.rows.length).toBe(4);
    for (const s of sums.rows) {
      const b = balances.rows.find((r) => r.branch_id === s.branch_id && r.variant_id === s.variant_id);
      expect(b).toBeDefined();
      expect(b!.quantity_on_hand).toBe(s.total);
    }

    // The reconciliation view must show a 0 delta everywhere.
    const deltas = await fx.db.withContext(ctx(), (tx) =>
      tx.query("SELECT * FROM v_stock_reconciliation WHERE org_id = $1 AND delta <> 0", [fx.orgA]),
    );
    expect(deltas.rows.length).toBe(0);
  });

  it("a duplicate idempotency_key is rejected with zero side effects", async () => {
    const before = await fx.db.withContext(ctx(), (tx) =>
      tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]),
    );
    const invBefore = await fx.db.withContext(ctx(), (tx) =>
      tx.query(
        "SELECT COALESCE(SUM(quantity_on_hand), 0)::numeric(14,4) AS total FROM inventory_items WHERE org_id = $1",
        [fx.orgA],
      ),
    );

    let threw = false;
    try {
      await fx.db.withContext(ctx(), (tx) =>
        tx.query(
          `INSERT INTO stock_ledger (org_id, branch_id, variant_id, movement_type, quantity, reference_type, idempotency_key)
           VALUES ($1, $2, $3, 'grn', 5, 'grn', 'ledger-1')`,
          [fx.orgA, fx.branchA1, fx.variantA],
        ),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = await fx.db.withContext(ctx(), (tx) =>
      tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]),
    );
    const invAfter = await fx.db.withContext(ctx(), (tx) =>
      tx.query(
        "SELECT COALESCE(SUM(quantity_on_hand), 0)::numeric(14,4) AS total FROM inventory_items WHERE org_id = $1",
        [fx.orgA],
      ),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(invAfter.rows[0].total).toBe(invBefore.rows[0].total);
  });

  it("stock_ledger is append-only: UPDATE and DELETE both raise", async () => {
    const statements = [
      "UPDATE stock_ledger SET quantity = quantity + 1 WHERE idempotency_key = 'ledger-1'",
      "DELETE FROM stock_ledger WHERE idempotency_key = 'ledger-1'",
    ];
    for (const sql of statements) {
      let threw = false;
      try {
        await fx.db.withContext(ctx(), (tx) => tx.exec(sql));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  it("clients can never write inventory_items directly (no RLS write policy)", async () => {
    let threw = false;
    try {
      await fx.db.withContext(ctx(), (tx) =>
        tx.query(
          "INSERT INTO inventory_items (org_id, branch_id, variant_id, quantity_on_hand) VALUES ($1, $2, $3, 999)",
          [fx.orgA, fx.branchA1, fx.variantA],
        ),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("RLS: org B cannot see org A's ledger", async () => {
    const r = await fx.db.withContext({ orgId: fx.orgB, userId: fx.ownerB }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]),
    );
    expect(r.rows[0].n).toBe(0);
  });
});

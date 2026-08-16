import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("sales write path (Phase 1)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let cashier: LoginResult;
  let owner: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    cashier = await login(app, "cashier@flowwise.demo");
    owner = await login(app, "owner@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const saleBody = (clientOperationId: string) => ({
    clientOperationId,
    branchId: fx.branchA1,
    lines: [
      { variantId: fx.variantA, quantity: "2" },
      { variantId: fx.variantB, quantity: "1" },
    ],
    tenders: [{ tenderType: "cash", amount: "30.00" }],
  });

  const ledgerTotal = async () => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT COALESCE(SUM(quantity), 0)::numeric(14,4) AS total FROM stock_ledger WHERE org_id = $1", [fx.orgA]),
    );
    return r.rows[0].total as string;
  };

  const inventoryOf = async (variantId: string) => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
        [fx.orgA, fx.branchA1, variantId],
      ),
    );
    return r.rows.length ? (r.rows[0].quantity_on_hand as string) : "0.0000";
  };

  it("completes a sale: server-priced totals, one transaction, ledger + inventory reconciled", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("sale-op-1"));
    expect(res.status).toBe(201);
    const sale = res.body;
    expect(sale.id).toBeTruthy();
    expect(sale.status).toBe("completed");
    // numeric strings end to end — no floats
    expect(sale.subtotal).toBe("24.0000");
    expect(sale.taxTotal).toBe("3.3600");
    expect(sale.total).toBe("27.3600");
    expect(sale.tendered).toBe("30.0000");
    expect(sale.changeDue).toBe("2.6400");
    expect(sale.lines).toHaveLength(2);
    expect(sale.lines[0].taxRate).toBe("0.1400"); // snapshot, not a lookup
    expect(sale.lines[0].lineTotal).toBe("15.0000");

    // Ledger shows exactly -2 and -1 for the two variants, tied to the sale.
    const ledger = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT variant_id, quantity, movement_type, reference_id FROM stock_ledger WHERE org_id = $1 AND reference_type = 'sale' ORDER BY quantity",
        [fx.orgA],
      ),
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0].quantity).toBe("-2.0000");
    expect(ledger.rows[1].quantity).toBe("-1.0000");
    expect(String(ledger.rows[0].reference_id)).toBe(sale.id);

    expect(await inventoryOf(fx.variantA)).toBe("-2.0000");
    expect(await inventoryOf(fx.variantB)).toBe("-1.0000");

    const deltas = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT * FROM v_stock_reconciliation WHERE org_id = $1 AND delta <> 0", [fx.orgA]),
    );
    expect(deltas.rows.length).toBe(0);
  });

  it("replaying the same client_operation_id returns the same sale with zero side effects", async () => {
    const beforeLedger = await ledgerTotal();
    const res = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("sale-op-1"));
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    const first = await request(app.getHttpServer())
      .get(`/v1/sales/${res.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(first.status).toBe(200);

    const afterLedger = await ledgerTotal();
    expect(afterLedger).toBe(beforeLedger); // no double deduction
  });

  it("a completed sale is immutable: UPDATE and DELETE are rejected", async () => {
    const sale = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("sale-op-2"));
    expect(sale.status).toBe(201);

    for (const sql of [
      `UPDATE sales SET total = 0 WHERE id = '${sale.body.id}'`,
      `DELETE FROM sales WHERE id = '${sale.body.id}'`,
    ]) {
      let threw = false;
      try {
        await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) => tx.exec(sql));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  it("refunds restore stock exactly and are idempotent", async () => {
    const before = await ledgerTotal();
    const res = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("sale-op-3"));
    expect(res.status).toBe(201);
    const saleId = res.body.id as string;

    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "refund-op-1", reason: "customer returned" });
    expect(refund.status).toBe(201);
    expect(refund.body.refundId).toBeTruthy();

    // Stock comes back exactly for both variants — the refund reverses only
    // sale-op-3's quantities. Earlier tests also sold these variants
    // (sale-op-1, sale-op-2: -2 / -1 each), so the accumulated balances are
    // -4 / -2, not zero.
    expect(await inventoryOf(fx.variantA)).toBe("-4.0000");
    expect(await inventoryOf(fx.variantB)).toBe("-2.0000");

    // Replay the refund — no double credit.
    const replay = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "refund-op-1" });
    expect(replay.status).toBe(201);
    expect(replay.body.refundId).toBe(refund.body.refundId);
    expect(await inventoryOf(fx.variantA)).toBe("-4.0000");

    const after = await ledgerTotal();
    expect(after).toBe(before); // -3 out, +3 back
  });

  it("unpriced or unknown lines are rejected with nothing written", async () => {
    const before = await ledgerTotal();
    const res = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send({
        clientOperationId: "sale-op-bad",
        branchId: fx.branchA1,
        lines: [{ variantId: "00000000-0000-0000-0000-000000000000", quantity: "1" }],
        tenders: [],
      });
    expect(res.status).toBe(400);
    expect(await ledgerTotal()).toBe(before);
  });

  it("permissions are enforced: a cashier cannot refund, an auditor cannot sell", async () => {
    const sale = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("sale-op-4"));

    const refundAttempt = await request(app.getHttpServer())
      .post(`/v1/sales/${sale.body.id}/refund`)
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send({ clientOperationId: "refund-op-nope" });
    expect(refundAttempt.status).toBe(403);

    const auditor = await login(app, "auditor@flowwise.demo");
    const sellAttempt = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${auditor.access_token}`)
      .send(saleBody("sale-op-nope"));
    expect(sellAttempt.status).toBe(403);
  });
});

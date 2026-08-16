import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login } from "./helpers.js";

/**
 * Phase 4 exit drill — "a full trading day with zero network".
 *
 * The branch runs entirely offline; every write lands in the outbox. On
 * reconnect the till flushes POST /v1/outbox and EVERYTHING must reconcile
 * exactly against the ledger, replay-safe:
 *
 *   offline sales        → queued, priced server-side at flush time
 *   offline refund       → new refund document + reverse movements
 *   offline GRN          → batch metadata + ledger rows in one tx
 *   offline adjustment   → approved in one op (createAndPost)
 *   offline transfer     → BOTH ledger legs in one tx
 *   offline count post   → server snapshots expected, variance → ledger
 *
 * The scenario mirrors the product's real capabilities: a count is opened and
 * recorded online (blind — expected hidden), then posted offline; refunds can
 * only reference sales already known to the device.
 */
describe("full outage day: offline ops flush to an exact, replay-safe reconciliation", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let cashierToken: string;
  let ownerToken: string;
  let stockToken: string;

  // Offline op ids (stable so we can replay the exact same batch).
  const ops = {
    sale2: "outage-sale-2",
    refund1: "outage-refund-1",
    grn1: "outage-grn-1",
    adj1: "outage-adj-1",
    trf1: "outage-trf-1",
    countPost: "outage-count-post-1",
  };

  let sale1Id: string;
  let countId: string;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);

    // ---- Opening stock (branch A1: variantA 100, variantB 50; A2: variantA 30).
    // The ledger is the source of truth from the very first row.
    await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, async (tx) => {
      const rows = [
        { branch: fx.branchA1, variant: fx.variantA, qty: "100.0000" },
        { branch: fx.branchA1, variant: fx.variantB, qty: "50.0000" },
        { branch: fx.branchA2, variant: fx.variantA, qty: "30.0000" },
      ];
      for (const r of rows) {
        await tx.query(
          `INSERT INTO stock_ledger
             (org_id, branch_id, variant_id, movement_type, quantity, unit_cost,
              reference_type, reference_id, idempotency_key, created_by_user_id)
           VALUES ($1, $2, $3, 'opening', $4::numeric(14,4), NULL,
                   'import', NULL, $5, $6)`,
          [fx.orgA, r.branch, r.variant, r.qty, `outage:opening:${r.branch}:${r.variant}`, fx.stockA],
        );
      }
    });

    cashierToken = (await login(app, "cashier@flowwise.demo")).access_token;
    ownerToken = (await login(app, "owner@flowwise.demo")).access_token;
    stockToken = (await login(app, "stock@flowwise.demo")).access_token;

    // ---- Online, before the outage -----------------------------------------
    // One sale is rung ONLINE so the till knows its server id (refunds of
    // previously-synced sales are what a till can do offline).
    const sale1 = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashierToken}`)
      .send({
        clientOperationId: "outage-sale-1",
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantA, quantity: "2" }],
        tenders: [{ tenderType: "cash", amount: "20.00" }],
      });
    expect(sale1.status).toBe(201);
    sale1Id = sale1.body.id as string;

    // A blind count is opened + recorded online (expected quantities stay
    // hidden until post) and POSTED offline as part of the outage batch.
    const opened = await request(app.getHttpServer())
      .post("/v1/counts")
      .set("Authorization", `Bearer ${stockToken}`)
      .send({ clientOperationId: "outage-count-1", branchId: fx.branchA1, variantIds: [fx.variantA, fx.variantB] });
    expect(opened.status).toBe(201);
    countId = opened.body.id as string;
    const recorded = await request(app.getHttpServer())
      .post(`/v1/counts/${countId}/record`)
      .set("Authorization", `Bearer ${stockToken}`)
      .send({ counted: [{ variantId: fx.variantA, quantity: "100" }, { variantId: fx.variantB, quantity: "60" }] });
    expect(recorded.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  /** The exact offline batch, rebuilt identically each time it is replayed. */
  function offlineBatches() {
    const saleOp = {
      id: "local-sale-2",
      type: "sale",
      clientOperationId: ops.sale2,
      payload: {
        branchId: fx.branchA1,
        lines: [
          { variantId: fx.variantA, quantity: "1" },
          { variantId: fx.variantB, quantity: "1" },
        ],
        tenders: [{ tenderType: "cash", amount: "20.00" }],
      },
    };
    const refundOp = {
      id: "local-refund-1",
      type: "refund",
      clientOperationId: ops.refund1,
      payload: { saleId: sale1Id, amount: "17.1000", reason: "customer returned item" },
    };
    const grnOp = {
      id: "local-grn-1",
      type: "grn",
      clientOperationId: ops.grn1,
      payload: {
        branchId: fx.branchA1,
        lines: [
          { variantId: fx.variantA, quantity: "10", unitCost: "6.00" },
          { variantId: fx.variantB, quantity: "5", unitCost: "5.50" },
        ],
      },
    };
    const adjOp = {
      id: "local-adj-1",
      type: "adjustment",
      clientOperationId: ops.adj1,
      payload: {
        branchId: fx.branchA1,
        adjustmentType: "increase",
        reason: "damaged stock found on shelf",
        lines: [{ variantId: fx.variantB, quantity: "3" }],
      },
    };
    const trfOp = {
      id: "local-trf-1",
      type: "transfer",
      clientOperationId: ops.trf1,
      payload: {
        fromBranchId: fx.branchA1,
        toBranchId: fx.branchA2,
        lines: [{ variantId: fx.variantA, quantity: "4" }],
      },
    };
    const countOp = {
      id: "local-count-post-1",
      type: "count.post",
      clientOperationId: ops.countPost,
      payload: { countId },
    };

    return [
      { token: cashierToken, operations: [saleOp] },
      { token: ownerToken, operations: [refundOp] },
      { token: stockToken, operations: [grnOp, adjOp, trfOp, countOp] },
    ];
  }

  async function flush(batches: { token: string; operations: unknown[] }[]): Promise<number> {
    let errored = 0;
    for (const batch of batches) {
      const res = await request(app.getHttpServer())
        .post("/v1/outbox")
        .set("Authorization", `Bearer ${batch.token}`)
        .send({ operations: batch.operations });
      expect(res.status).toBe(201);
      const results = res.body.results as { id: string; status: string; httpStatus?: number; error?: string }[];
      expect(results).toHaveLength(batch.operations.length);
      for (const r of results) {
        if (r.status !== "ok") {
          errored += 1;
          console.error(`op ${r.id} failed: ${r.httpStatus} ${r.error}`);
        }
      }
    }
    return errored;
  }

  async function balances(): Promise<Map<string, string>> {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, (tx) =>
      tx.query("SELECT branch_id, variant_id, quantity_on_hand FROM inventory_items WHERE org_id = $1", [fx.orgA]),
    );
    const map = new Map<string, string>();
    for (const row of r.rows) map.set(`${row.branch_id}:${row.variant_id}`, row.quantity_on_hand as string);
    return map;
  }

  it("flushes a full offline day with zero errors and exact ledger reconciliation", async () => {
    const errors = await flush(offlineBatches());
    expect(errors).toBe(0);

    // Hand-computed expected balances for the whole day:
    //   A1 variantA: 100 - sale1(2) - sale2(1) + refund(2) + grn(10) - trf(4) + count(-5) = 100
    //   A1 variantB:  50 - sale2(1) + grn(5) + adj(3) + count(+3)                          = 60
    //   A2 variantA:  30 + trf(4)                                                          = 34
    const b = await balances();
    expect(b.get(`${fx.branchA1}:${fx.variantA}`)).toBe("100.0000");
    expect(b.get(`${fx.branchA1}:${fx.variantB}`)).toBe("60.0000");
    expect(b.get(`${fx.branchA2}:${fx.variantA}`)).toBe("34.0000");

    // The derived cache reconciles perfectly to the ledger (Invariants 1 & 2).
    const reconcile = await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, (tx) =>
      tx.query("SELECT delta FROM v_stock_reconciliation WHERE org_id = $1", [fx.orgA]),
    );
    expect(reconcile.rows.length).toBeGreaterThan(0);
    for (const row of reconcile.rows) {
      expect(row.delta).toBe("0.0000");
    }

    // Exactly one of each document; the offline sale got server-priced + taxed.
    const docs = await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, async (tx) => {
      const sales = await tx.query("SELECT client_operation_id FROM sales WHERE org_id = $1", [fx.orgA]);
      const refunds = await tx.query("SELECT client_operation_id FROM sale_refunds WHERE org_id = $1", [fx.orgA]);
      const grns = await tx.query("SELECT client_operation_id FROM goods_receipts WHERE org_id = $1", [fx.orgA]);
      const adjustments = await tx.query("SELECT client_operation_id FROM stock_adjustments WHERE org_id = $1", [fx.orgA]);
      const transfers = await tx.query("SELECT client_operation_id FROM stock_transfers WHERE org_id = $1", [fx.orgA]);
      const counts = await tx.query("SELECT status FROM stock_counts WHERE org_id = $1", [fx.orgA]);
      return { sales, refunds, grns, adjustments, transfers, counts };
    });
    expect(docs.sales.rows.map((r) => r.client_operation_id).sort()).toEqual(["outage-sale-1", "outage-sale-2"]);
    expect(docs.refunds.rows).toHaveLength(1);
    expect(docs.grns.rows).toHaveLength(1);
    expect(docs.adjustments.rows).toHaveLength(1);
    expect(docs.transfers.rows).toHaveLength(1);
    expect(docs.counts.rows[0].status).toBe("posted");

    const sale2 = await request(app.getHttpServer())
      .get(`/v1/sales/${docs.sales.rows[0].client_operation_id === "outage-sale-2" ? "" : ""}`)
      .catch(() => null); // noop — sale lookup by id below
    void sale2;

    // The offline sale was priced server-side with the org VAT (14%).
    const sale2Doc = await fx.db.withContext({ orgId: fx.orgA, userId: fx.cashierA }, (tx) =>
      tx.query("SELECT total FROM sales WHERE org_id = $1 AND client_operation_id = $2", [fx.orgA, ops.sale2]),
    );
    expect(sale2Doc.rows[0].total).toBe("18.8100"); // 16.50 + 14%
  });

  it("replaying the exact same offline batch has zero side effects", async () => {
    const before = await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, async (tx) => {
      const ledger = await tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]);
      const sales = await tx.query("SELECT count(*)::int AS n FROM sales WHERE org_id = $1", [fx.orgA]);
      const movements = await tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]);
      return { ledger: ledger.rows[0].n as number, sales: sales.rows[0].n as number, movements: movements.rows[0].n as number };
    });

    const errors = await flush(offlineBatches());
    expect(errors).toBe(0);

    const after = await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, async (tx) => {
      const ledger = await tx.query("SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1", [fx.orgA]);
      const sales = await tx.query("SELECT count(*)::int AS n FROM sales WHERE org_id = $1", [fx.orgA]);
      return { ledger: ledger.rows[0].n as number, sales: sales.rows[0].n as number };
    });
    expect(after.ledger).toBe(before.ledger);
    expect(after.sales).toBe(before.sales);

    // Balances are untouched by the replay.
    const b = await balances();
    expect(b.get(`${fx.branchA1}:${fx.variantA}`)).toBe("100.0000");
    expect(b.get(`${fx.branchA1}:${fx.variantB}`)).toBe("60.0000");
    expect(b.get(`${fx.branchA2}:${fx.variantA}`)).toBe("34.0000");
  });
});

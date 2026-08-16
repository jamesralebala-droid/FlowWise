import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("FEFO + batch-aware sales (Phase 2)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let stock: LoginResult;
  let cashier: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    stock = await login(app, "stock@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const inventoryOf = async (branchId: string, variantId: string) => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
        [fx.orgA, branchId, variantId],
      ),
    );
    return r.rows.length ? (r.rows[0].quantity_on_hand as string) : "0.0000";
  };

  const batchOnHand = async (batchId: string) => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT COALESCE(SUM(quantity), 0)::numeric(14,4) AS on_hand FROM stock_ledger WHERE batch_id = $1", [batchId]),
    );
    return r.rows[0].on_hand as string;
  };

  const grn = async (clientOperationId: string, line: { quantity: string; batchNo: string; expiryDate: string }) => {
    const draft = await request(app.getHttpServer())
      .post("/v1/grns")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({
        clientOperationId,
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantA, quantity: line.quantity, unitCost: "4.0000", batchNo: line.batchNo, expiryDate: line.expiryDate }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/grns/${draft.body.id}/post`)
      .set("Authorization", `Bearer ${stock.access_token}`);
    expect(posted.status).toBe(201);
    return posted.body as { id: string; lines: { batchId: string | null; batchNo: string | null }[] };
  };

  const sale = (clientOperationId: string, quantity: string, batchId?: string) =>
    request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send({
        clientOperationId,
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantA, quantity, ...(batchId ? { batchId } : {}) }],
        tenders: [{ tenderType: "cash", amount: "100.00" }],
      });

  const push = (token: string, operations: unknown[]) =>
    request(app.getHttpServer())
      .post("/v1/outbox")
      .set("Authorization", `Bearer ${token}`)
      .send({ operations });

  let lotE: string;
  let lotL: string;

  it("two batches land with FEFO ordering metadata", async () => {
    const g1 = await grn("f-g1", { quantity: "5", batchNo: "LOT-E", expiryDate: "2026-06-01" });
    const g2 = await grn("f-g2", { quantity: "5", batchNo: "LOT-L", expiryDate: "2027-01-01" });
    lotE = g1.lines[0].batchId as string;
    lotL = g2.lines[0].batchId as string;
    expect(lotE).toBeTruthy();
    expect(lotL).toBeTruthy();
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");
  });

  it("an explicit batchId sells only from that batch", async () => {
    const res = await sale("f-s2", "3", lotL);
    expect(res.status).toBe(201);
    expect(res.body.lines[0].batchId).toBe(lotL);
    expect(await batchOnHand(lotL)).toBe("2.0000");
    expect(await batchOnHand(lotE)).toBe("5.0000");
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("7.0000");
  });

  it("a refund restores the exact batch (not just the variant)", async () => {
    const s2 = await sale("f-s2", "3", lotL); // replay-safe: same sale
    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${s2.body.id}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "f-ref-2", reason: "return" });
    expect(refund.status).toBe(201);
    expect(await batchOnHand(lotL)).toBe("5.0000");
    expect(await batchOnHand(lotE)).toBe("5.0000");
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");
  });

  it("auto FEFO: a 7-unit sale splits — earliest expiry first, never oversold", async () => {
    const res = await sale("f-s1", "7");
    expect(res.status).toBe(201);
    expect(res.body.lines[0].batchId).toBeNull(); // split across batches

    const rows = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT batch_id, quantity FROM stock_ledger WHERE org_id = $1 AND reference_type = 'sale' AND reference_id = $2 ORDER BY quantity",
        [fx.orgA, res.body.id],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(String(rows.rows[0].batch_id)).toBe(lotE);
    expect(rows.rows[0].quantity).toBe("-5.0000");
    expect(String(rows.rows[1].batch_id)).toBe(lotL);
    expect(rows.rows[1].quantity).toBe("-2.0000");

    expect(await batchOnHand(lotE)).toBe("0.0000");
    expect(await batchOnHand(lotL)).toBe("3.0000");
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("3.0000");

    // The per-branch batch endpoint reflects the split.
    const batches = await request(app.getHttpServer())
      .get("/v1/stock/batches")
      .query({ branchId: fx.branchA1 })
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(batches.status).toBe(200);
    const lotLRow = (batches.body.batches as { id: string; quantityOnHand: string }[]).find((b) => b.id === lotL);
    expect(lotLRow?.quantityOnHand).toBe("3.0000");
  });

  it("oversell resolution: batch-tracked variants reject uncovered sales with nothing written", async () => {
    const before = await inventoryOf(fx.branchA1, fx.variantA);
    const res = await sale("f-bad-1", "99");
    expect(res.status).toBe(400);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe(before);

    const explicitBad = await sale("f-bad-2", "99", lotL);
    expect(explicitBad.status).toBe(400);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe(before);

    const unknownBatch = await sale("f-bad-3", "1", "00000000-0000-0000-0000-000000000000");
    expect(unknownBatch.status).toBe(400);

    // A batch of another branch is not sellable here.
    const crossBranch = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send({
        clientOperationId: "f-bad-4",
        branchId: fx.branchA2,
        lines: [{ variantId: fx.variantA, quantity: "1", batchId: lotL }],
        tenders: [],
      });
    expect(crossBranch.status).toBe(400);
    expect(await inventoryOf(fx.branchA2, fx.variantA)).toBe("0.0000");
  });

  it("refunding the FEFO sale restores every batch it drew from", async () => {
    const s1 = await sale("f-s1", "7"); // replay-safe: same sale
    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${s1.body.id}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "f-ref-1" });
    expect(refund.status).toBe(201);
    expect(await batchOnHand(lotE)).toBe("5.0000");
    expect(await batchOnHand(lotL)).toBe("5.0000");
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");
  });

  it("outbox: a GRN op posts through the batch (and replay is a no-op)", async () => {
    const op = {
      id: "op-grn",
      type: "grn",
      clientOperationId: "ob-grn-1",
      payload: {
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantB, quantity: "4", unitCost: "2.5000" }],
      },
    };
    const res = await push(stock.access_token, [op]);
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[0].body.status).toBe("posted");
    const grnId = res.body.results[0].body.id as string;
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("4.0000");

    const replay = await push(stock.access_token, [op]);
    expect(replay.body.results[0].status).toBe("ok");
    expect(replay.body.results[0].body.id).toBe(grnId);
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("4.0000");
  });

  it("outbox: a transfer op writes both legs", async () => {
    const res = await push(stock.access_token, [
      {
        id: "op-trf",
        type: "transfer",
        clientOperationId: "ob-trf-1",
        payload: { fromBranchId: fx.branchA1, toBranchId: fx.branchA2, lines: [{ variantId: fx.variantB, quantity: "1" }] },
      },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[0].body.status).toBe("posted");
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("3.0000");
    expect(await inventoryOf(fx.branchA2, fx.variantB)).toBe("1.0000");
  });

  it("outbox: an adjustment op posts (approver perms enforced per op)", async () => {
    // Cashier lacks stock.adjust.approve — the op fails, nothing written.
    const denied = await push(cashier.access_token, [
      {
        id: "op-adj",
        type: "adjustment",
        clientOperationId: "ob-adj-1",
        payload: { branchId: fx.branchA1, adjustmentType: "increase", reason: "x", lines: [{ variantId: fx.variantB, quantity: "2" }] },
      },
    ]);
    expect(denied.body.results[0].status).toBe("error");
    expect(denied.body.results[0].httpStatus).toBe(403);

    const res = await push(stock.access_token, [
      {
        id: "op-adj",
        type: "adjustment",
        clientOperationId: "ob-adj-1",
        payload: { branchId: fx.branchA1, adjustmentType: "increase", reason: "x", lines: [{ variantId: fx.variantB, quantity: "2" }] },
      },
    ]);
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[0].body.status).toBe("posted");
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("5.0000");
  });

  it("outbox: a count.post op applies the approved variance", async () => {
    const open = await request(app.getHttpServer())
      .post("/v1/counts")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ clientOperationId: "ob-cnt-1", branchId: fx.branchA1, variantIds: [fx.variantB] });
    expect(open.status).toBe(201);
    const countId = open.body.id as string;
    await request(app.getHttpServer())
      .post(`/v1/counts/${countId}/record`)
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ counted: [{ variantId: fx.variantB, quantity: "6" }] });

    const res = await push(stock.access_token, [{ id: "op-cnt", type: "count.post", clientOperationId: "ob-cnt-1", payload: { countId } }]);
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[0].body.status).toBe("posted");
    // expected 5 (4 grn - 1 transfer + 2 adj) → counted 6 → variance +1.
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("6.0000");
  });

  it("the ledger still reconciles exactly after all batch flows", async () => {
    const deltas = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT * FROM v_stock_reconciliation WHERE org_id = $1 AND delta <> 0", [fx.orgA]),
    );
    expect(deltas.rows.length).toBe(0);
  });
});

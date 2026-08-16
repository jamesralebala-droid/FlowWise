import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("outbox push (Phase 1)", () => {
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

  const push = (token: string, operations: unknown[]) =>
    request(app.getHttpServer())
      .post("/v1/outbox")
      .set("Authorization", `Bearer ${token}`)
      .send({ operations });

  const saleOp = (id: string, clientOperationId: string) => ({
    id,
    type: "sale",
    clientOperationId,
    payload: {
      branchId: fx.branchA1,
      lines: [
        { variantId: fx.variantA, quantity: "2" },
        { variantId: fx.variantB, quantity: "1" },
      ],
      tenders: [{ tenderType: "cash", amount: "30.00" }],
    },
  });

  const refundOp = (id: string, clientOperationId: string, saleId: string) => ({
    id,
    type: "refund",
    clientOperationId,
    payload: { saleId, reason: "offline refund" },
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

  it("a queued sale completes via the batch, and replaying the batch resolves to the same sale", async () => {
    const res = await push(cashier.access_token, [saleOp("op-1", "ob-sale-1")]);
    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe("op-1");
    expect(res.body.results[0].status).toBe("ok");
    const sale = res.body.results[0].body;
    expect(sale.id).toBeTruthy();
    expect(sale.total).toBe("27.3600");
    expect(await inventoryOf(fx.variantA)).toBe("-2.0000");
    expect(await inventoryOf(fx.variantB)).toBe("-1.0000");

    // Dropped connection: the device retries the same batch.
    const before = await ledgerTotal();
    const replay = await push(cashier.access_token, [saleOp("op-1", "ob-sale-1")]);
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].status).toBe("ok");
    expect(replay.body.results[0].body.id).toBe(sale.id);
    expect(await ledgerTotal()).toBe(before); // exactly one business effect
  });

  it("refund ops restore stock; a bad op fails in isolation", async () => {
    const res = await push(owner.access_token, [
      saleOp("op-sale", "ob-sale-2"),
      {
        id: "op-bad",
        type: "sale",
        clientOperationId: "ob-sale-bad",
        payload: {
          branchId: fx.branchA1,
          lines: [{ variantId: "00000000-0000-0000-0000-000000000000", quantity: "1" }],
          tenders: [],
        },
      },
    ]);
    expect(res.status).toBe(201);
    const saleResult = res.body.results[0];
    expect(saleResult.status).toBe("ok");
    const bad = res.body.results[1];
    expect(bad.id).toBe("op-bad");
    expect(bad.status).toBe("error");
    expect(bad.httpStatus).toBe(400);
    expect(await inventoryOf(fx.variantA)).toBe("-4.0000"); // ob-sale-1 + ob-sale-2

    // Refund the sale through the outbox too.
    const refund = await push(owner.access_token, [
      refundOp("op-refund", "ob-ref-2", saleResult.body.id),
    ]);
    expect(refund.status).toBe(201);
    expect(refund.body.results[0].status).toBe("ok");
    expect(refund.body.results[0].body.refundId).toBeTruthy();
    // Exactly the quantities that sale took are restored.
    expect(await inventoryOf(fx.variantA)).toBe("-2.0000");
    expect(await inventoryOf(fx.variantB)).toBe("-1.0000");

    // Replay the refund op — no double credit.
    const replay = await push(owner.access_token, [
      refundOp("op-refund", "ob-ref-2", saleResult.body.id),
    ]);
    expect(replay.body.results[0].status).toBe("ok");
    expect(replay.body.results[0].body.refundId).toBe(refund.body.results[0].body.refundId);
    expect(await inventoryOf(fx.variantA)).toBe("-2.0000");
  });

  it("per-op permissions: a cashier's refund op is rejected while sales proceed", async () => {
    const res = await push(cashier.access_token, [
      saleOp("op-sale", "ob-sale-3"),
      { id: "op-refund", type: "refund", clientOperationId: "ob-ref-3", payload: {} },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[1].id).toBe("op-refund");
    expect(res.body.results[1].status).toBe("error");
    expect(res.body.results[1].httpStatus).toBe(403);
  });

  it("an auditor's ops fail per-op (route is open to any authenticated device)", async () => {
    const auditor = await login(app, "auditor@flowwise.demo");
    const res = await push(auditor.access_token, [saleOp("op-1", "ob-sale-4")]);
    // Any authenticated device may flush; the op itself is denied by the
    // per-operation permission check.
    expect(res.status).toBe(201);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].httpStatus).toBe(403);
  });

  it("an empty batch is rejected", async () => {
    const res = await push(cashier.access_token, []);
    expect(res.status).toBe(400);
  });
});

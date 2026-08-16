import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("inventory operations (Phase 2)", () => {
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

  const grnBody = (clientOperationId: string, lines: unknown[]) => ({
    clientOperationId,
    branchId: fx.branchA1,
    lines,
  });

  it("suppliers: create, duplicate code conflict, variant mappings", async () => {
    const created = await request(app.getHttpServer())
      .post("/v1/suppliers")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ name: "Beverage Wholesalers", code: "SUP-1", paymentTerms: "Net 30" });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe("SUP-1");

    const dup = await request(app.getHttpServer())
      .post("/v1/suppliers")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ name: "Duplicate", code: "sup-1" });
    expect(dup.status).toBe(409);

    const mapped = await request(app.getHttpServer())
      .put(`/v1/suppliers/${created.body.id}/products`)
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ products: [{ variantId: fx.variantA, supplierSku: "BW-330", unitCost: "4.7500", isDefault: true }] });
    expect(mapped.status).toBe(200);
    expect(mapped.body.products).toHaveLength(1);
    expect(mapped.body.products[0].unitCost).toBe("4.7500");
  });

  it("GRN: draft → post moves stock + creates batches; replay and re-post are idempotent", async () => {
    const draft = await request(app.getHttpServer())
      .post("/v1/grns")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send(
        grnBody("grn-1", [
          { variantId: fx.variantA, quantity: "10", unitCost: "5.0000", batchNo: "LOT-1", expiryDate: "2026-06-01" },
          { variantId: fx.variantB, quantity: "5", unitCost: "6.0000" },
        ]),
      );
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");
    const grnId = draft.body.id as string;

    const posted = await request(app.getHttpServer())
      .post(`/v1/grns/${grnId}/post`)
      .set("Authorization", `Bearer ${stock.access_token}`);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("posted");
    expect(posted.body.lines).toHaveLength(2);

    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("5.0000");

    const batches = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT batch_no, expiry_date FROM batches WHERE org_id = $1", [fx.orgA]),
    );
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0].batch_no).toBe("LOT-1");

    // Replay the create (dropped response) → same document, no extra stock.
    const replay = await request(app.getHttpServer())
      .post("/v1/grns")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send(
        grnBody("grn-1", [
          { variantId: fx.variantA, quantity: "10", unitCost: "5.0000", batchNo: "LOT-1", expiryDate: "2026-06-01" },
          { variantId: fx.variantB, quantity: "5", unitCost: "6.0000" },
        ]),
      );
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(grnId);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");

    // Re-post (retry) → idempotent, still posted, still one batch.
    const repost = await request(app.getHttpServer())
      .post(`/v1/grns/${grnId}/post`)
      .set("Authorization", `Bearer ${stock.access_token}`);
    expect(repost.status).toBe(201);
    expect(repost.body.id).toBe(grnId);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("10.0000");
  });

  it("posted documents are immutable: GRN UPDATE/DELETE are rejected", async () => {
    const grn = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT id FROM goods_receipts WHERE org_id = $1 AND document_no LIKE 'GRN-%' LIMIT 1", [fx.orgA]),
    );
    for (const sql of [
      `UPDATE goods_receipts SET notes = 'hacked' WHERE id = '${grn.rows[0].id}'`,
      `DELETE FROM goods_receipts WHERE id = '${grn.rows[0].id}'`,
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

  it("split deliveries reuse the batch row: a second GRN adds to LOT-1", async () => {
    const posted = await request(app.getHttpServer())
      .post("/v1/grns")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send(
        grnBody("grn-2", [{ variantId: fx.variantA, quantity: "4", unitCost: "5.0000", batchNo: "LOT-1", expiryDate: "2026-06-01" }]),
      )
      .then((d) => request(app.getHttpServer()).post(`/v1/grns/${(d.body as { id: string }).id}/post`).set("Authorization", `Bearer ${stock.access_token}`));
    expect(posted.status).toBe(201);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("14.0000");

    const batches = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM batches WHERE org_id = $1 AND batch_no = 'LOT-1'", [fx.orgA]),
    );
    expect(batches.rows[0].n).toBe(1); // metadata reused; quantity is the ledger sum
  });

  it("adjustments: increase posts, decrease below zero is rejected, cashier cannot post", async () => {
    const draft = await request(app.getHttpServer())
      .post("/v1/adjustments")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({
        clientOperationId: "adj-1",
        branchId: fx.branchA1,
        adjustmentType: "increase",
        reason: "damaged packaging correction",
        lines: [{ variantId: fx.variantB, quantity: "2", unitCost: "6.0000" }],
      });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");

    const cashierPost = await request(app.getHttpServer())
      .post(`/v1/adjustments/${draft.body.id}/post`)
      .set("Authorization", `Bearer ${cashier.access_token}`);
    expect(cashierPost.status).toBe(403);

    const posted = await request(app.getHttpServer())
      .post(`/v1/adjustments/${draft.body.id}/post`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("posted");
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("7.0000");

    // Oversell resolution: a decrease beyond on-hand never goes negative.
    const badDraft = await request(app.getHttpServer())
      .post("/v1/adjustments")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({
        clientOperationId: "adj-bad",
        branchId: fx.branchA1,
        adjustmentType: "decrease",
        reason: "too much",
        lines: [{ variantId: fx.variantB, quantity: "999" }],
      });
    expect(badDraft.status).toBe(201);
    const badPost = await request(app.getHttpServer())
      .post(`/v1/adjustments/${badDraft.body.id}/post`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(badPost.status).toBe(400);
    expect(await inventoryOf(fx.branchA1, fx.variantB)).toBe("7.0000");
  });

  it("transfers: both ledger legs commit; source stock is validated", async () => {
    const draft = await request(app.getHttpServer())
      .post("/v1/transfers")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({
        clientOperationId: "trf-1",
        fromBranchId: fx.branchA1,
        toBranchId: fx.branchA2,
        lines: [{ variantId: fx.variantA, quantity: "3" }],
      });
    expect(draft.status).toBe(201);

    const posted = await request(app.getHttpServer())
      .post(`/v1/transfers/${draft.body.id}/post`)
      .set("Authorization", `Bearer ${stock.access_token}`);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("posted");

    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("11.0000");
    expect(await inventoryOf(fx.branchA2, fx.variantA)).toBe("3.0000");

    // Both legs exist, one out and one in, same document.
    const legs = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT movement_type FROM stock_ledger WHERE org_id = $1 AND reference_type = 'transfer' AND reference_id = $2 ORDER BY movement_type",
        [fx.orgA, posted.body.id],
      ),
    );
    // Enum ORDER BY follows declaration order — sort before comparing.
    expect(legs.rows.map((r) => r.movement_type).sort()).toEqual(["transfer_in", "transfer_out"]);

    // Oversell: transferring more than on hand is rejected with nothing written.
    const over = await request(app.getHttpServer())
      .post("/v1/transfers")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({
        clientOperationId: "trf-bad",
        fromBranchId: fx.branchA1,
        toBranchId: fx.branchA2,
        lines: [{ variantId: fx.variantA, quantity: "999" }],
      });
    expect(over.status).toBe(201);
    const overPost = await request(app.getHttpServer())
      .post(`/v1/transfers/${over.body.id}/post`)
      .set("Authorization", `Bearer ${stock.access_token}`);
    expect(overPost.status).toBe(400);
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("11.0000");
  });

  it("blind counts: server-computed variance becomes the ledger movement; one open count per branch", async () => {
    // variantA at branchA1 is now 11 — the count must not see that number.
    const open = await request(app.getHttpServer())
      .post("/v1/counts")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ clientOperationId: "cnt-1", branchId: fx.branchA1, variantIds: [fx.variantA] });
    expect(open.status).toBe(201);
    expect(open.body.lines[0].expectedQuantity).toBeNull(); // blind — hidden
    const countId = open.body.id as string;

    const counted = await request(app.getHttpServer())
      .post(`/v1/counts/${countId}/record`)
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ counted: [{ variantId: fx.variantA, quantity: "5" }] });
    expect(counted.status).toBe(201);
    expect(counted.body.status).toBe("counted");

    const cashierPost = await request(app.getHttpServer())
      .post(`/v1/counts/${countId}/post`)
      .set("Authorization", `Bearer ${cashier.access_token}`);
    expect(cashierPost.status).toBe(403);

    const posted = await request(app.getHttpServer())
      .post(`/v1/counts/${countId}/post`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("posted");
    expect(posted.body.lines[0].expectedQuantity).toBe("11.0000"); // server snapshot
    expect(posted.body.lines[0].variance).toBe("-6.0000"); // 5 counted vs 11 expected
    expect(await inventoryOf(fx.branchA1, fx.variantA)).toBe("5.0000");

    // One live (open/counted) count per branch — a second open count conflicts.
    const second = await request(app.getHttpServer())
      .post("/v1/counts")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ clientOperationId: "cnt-2", branchId: fx.branchA1, variantIds: [fx.variantB] });
    expect(second.status).toBe(201);
    const third = await request(app.getHttpServer())
      .post("/v1/counts")
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ clientOperationId: "cnt-3", branchId: fx.branchA1, variantIds: [fx.variantB] });
    expect(third.status).toBe(409);

    // Post the second count to free the branch (zero variance — counted == expected).
    await request(app.getHttpServer())
      .post(`/v1/counts/${second.body.id}/record`)
      .set("Authorization", `Bearer ${stock.access_token}`)
      .send({ counted: [{ variantId: fx.variantB, quantity: "7" }] });
    const posted2 = await request(app.getHttpServer())
      .post(`/v1/counts/${second.body.id}/post`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(posted2.status).toBe(201);
    expect(posted2.body.lines[0].variance).toBe("0.0000");
  });

  it("low-stock alerts flag configured variants at or below reorder level", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/stock/low-stock")
      .query({ branchId: fx.branchA1 })
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(res.status).toBe(200);
    const flagged = res.body.lowStock as { variantId: string; reorderLevel: string }[];
    expect(flagged.some((f) => f.variantId === fx.variantB && f.reorderLevel === "10.0000")).toBe(true);
    expect(flagged.some((f) => f.variantId === fx.variantA)).toBe(false); // not reorder-configured
  });

  it("stock views return balances and the ledger", async () => {
    const balances = await request(app.getHttpServer())
      .get("/v1/stock/balances")
      .query({ branchId: fx.branchA1 })
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(balances.status).toBe(200);
    expect(balances.body.balances.length).toBeGreaterThan(0);

    const ledger = await request(app.getHttpServer())
      .get("/v1/stock/ledger")
      .query({ branchId: fx.branchA1 })
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.ledger.length).toBeGreaterThan(0);
  });

  it("RLS: org B can neither read nor write org A's inventory documents", async () => {
    const grns = await fx.db.withContext({ orgId: fx.orgB, userId: fx.ownerB }, (tx) =>
      tx.query("SELECT id FROM goods_receipts"),
    );
    expect(grns.rows.length).toBe(0);

    let threw = false;
    try {
      await fx.db.withContext({ orgId: fx.orgB, userId: fx.ownerB }, (tx) =>
        tx.query(
          "INSERT INTO goods_receipts (org_id, branch_id, document_no, client_operation_id) VALUES ($1, $2, 'X', 'x')",
          [fx.orgA, fx.branchA1],
        ),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const ownerB = await login(app, "boss@evilcorp.test");
    const list = await request(app.getHttpServer())
      .get("/v1/grns")
      .set("Authorization", `Bearer ${ownerB.access_token}`);
    expect(list.status).toBe(200);
    expect(list.body.grns).toHaveLength(0);
  });

  it("the ledger reconciles exactly at the end of the flows (delta 0 everywhere)", async () => {
    const deltas = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT * FROM v_stock_reconciliation WHERE org_id = $1 AND delta <> 0", [fx.orgA]),
    );
    expect(deltas.rows.length).toBe(0);
  });

  it("every privileged inventory action lands in audit_log", async () => {
    const audit = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT action FROM audit_log WHERE org_id = $1", [fx.orgA]),
    );
    const actions = audit.rows.map((r) => r.action as string);
    for (const expected of ["supplier.create", "grn.create", "grn.post", "adjustment.create", "adjustment.post", "transfer.create", "transfer.post", "count.create", "count.record", "count.post"]) {
      expect(actions).toContain(expected);
    }
  });
});

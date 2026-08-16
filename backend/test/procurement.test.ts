import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

interface CapturedRequest {
  event: string;
  signature: string;
  body: string;
}

describe("procurement & intelligence (Phase 3)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let stock: LoginResult;
  let cashier: LoginResult;

  let webhookServer: Server;
  let captured: CapturedRequest[] = [];
  let webhookPort = 0;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    stock = await login(app, "stock@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");

    captured = [];
    webhookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push({
          event: String(req.headers["x-flowwise-event"] ?? ""),
          signature: String(req.headers["x-flowwise-signature"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("webhook server bind timed out")), 5000);
      webhookServer.once("listening", () => {
        clearTimeout(timer);
        resolve();
      });
      webhookServer.listen(0, "127.0.0.1");
    });
    webhookPort = (webhookServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    if (webhookServer) await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await app.close();
    await fx.db.close();
  });

  const auth = (t: LoginResult) => ({ Authorization: `Bearer ${t.access_token}` });

  const createSupplier = async (t: LoginResult, code: string, products: unknown[]) => {
    const created = await request(app.getHttpServer())
      .post("/v1/suppliers")
      .set(auth(t))
      .send({ name: `Supplier ${code}`, code, paymentTerms: "Net 30" });
    expect(created.status).toBe(201);
    const mapped = await request(app.getHttpServer())
      .put(`/v1/suppliers/${created.body.id}/products`)
      .set(auth(t))
      .send({ products });
    expect(mapped.status).toBe(200);
    return created.body as { id: string };
  };

  const evaluate = async (t: LoginResult, branchId: string) => {
    const res = await request(app.getHttpServer()).post("/v1/reorder/evaluate").set(auth(t)).send({ branchId });
    expect(res.status).toBe(201);
    return res.body.suggestions as Record<string, any>[];
  };

  const openSuggestions = async (t: LoginResult, branchId: string) => {
    const res = await request(app.getHttpServer())
      .get("/v1/reorder/suggestions")
      .query({ branchId, status: "open" })
      .set(auth(t));
    expect(res.status).toBe(200);
    return res.body.suggestions as Record<string, any>[];
  };

  const postGrn = async (t: LoginResult, clientOperationId: string, lines: unknown[], poId?: string) => {
    const draft = await request(app.getHttpServer())
      .post("/v1/grns")
      .set(auth(t))
      .send({ clientOperationId, branchId: fx.branchA1, supplierId: fx.supplierId, poId, lines });
    expect(draft.status).toBe(201);
    const posted = await request(app.getHttpServer())
      .post(`/v1/grns/${draft.body.id}/post`)
      .set(auth(t));
    expect(posted.status).toBe(201);
    return posted.body as Record<string, any>;
  };

  it("reorder rules: upsert by (branch, variant), list, and cross-tenant isolation", async () => {
    const rule = await request(app.getHttpServer())
      .post("/v1/reorder/rules")
      .set(auth(stock))
      .send({ branchId: fx.branchA1, variantId: fx.variantA, reorderPoint: "5.0000", reorderQuantity: "12.0000", leadTimeDays: 2, safetyStockDays: 1 });
    expect(rule.status).toBe(201);
    expect(rule.body.reorderPoint).toBe("5.0000");
    const ruleId = rule.body.id as string;

    // Upsert with the same (branch, variant) updates, never duplicates.
    const updated = await request(app.getHttpServer())
      .post("/v1/reorder/rules")
      .set(auth(stock))
      .send({ branchId: fx.branchA1, variantId: fx.variantA, reorderPoint: "6.0000", reorderQuantity: "12.0000", leadTimeDays: 3 });
    expect(updated.status).toBe(201);
    expect(updated.body.id).toBe(ruleId);
    expect(updated.body.reorderPoint).toBe("6.0000");

    const listed = await request(app.getHttpServer()).get("/v1/reorder/rules").query({ branchId: fx.branchA1 }).set(auth(stock));
    expect(listed.status).toBe(200);
    expect(listed.body.rules).toHaveLength(1);

    // Cross-tenant: org B sees no rules and cannot write org A's.
    const bossB = await login(app, "boss@evilcorp.test");
    const seen = await request(app.getHttpServer()).get("/v1/reorder/rules").set(auth(bossB));
    expect(seen.body.rules).toHaveLength(0);
    const stolen = await request(app.getHttpServer())
      .post("/v1/reorder/rules")
      .set(auth(bossB))
      .send({ branchId: fx.branchA1, variantId: fx.variantA, reorderPoint: "1.0000", reorderQuantity: "1.0000" });
    expect(stolen.status).toBe(400); // branch not in org B
  });

  it("evaluator: explainable suggestion from the variant-level fallback (stock 0 ≤ reorder point 10)", async () => {
    const suggestions = await evaluate(stock, fx.branchA1);
    const forB = suggestions.find((s) => s.variantId === fx.variantB) as Record<string, any>;
    expect(forB).toBeDefined();
    expect(forB.currentStock).toBe("0.0000");
    expect(forB.reorderPoint).toBe("10.0000");
    expect(forB.suggestedQuantity).toBe("24.0000"); // configured reorder quantity
    expect(forB.avgDailyDemand).toBeNull(); // no sales yet
    expect(forB.daysOfCover).toBeNull();
    expect(forB.reason).toContain("below reorder point");
    expect(forB.reason).toContain("On hand 0.0000");

    // Re-running refreshes open suggestions in place — one row per item.
    const again = await evaluate(stock, fx.branchA1);
    expect(again.filter((s) => s.variantId === fx.variantB)).toHaveLength(1);
  });

  it("forecast: trailing-window average daily demand per variant", async () => {
    const forecast = await request(app.getHttpServer())
      .get("/v1/reorder/forecast")
      .query({ branchId: fx.branchA1 })
      .set(auth(owner));
    expect(forecast.status).toBe(200);
    const rows = forecast.body.forecast as Record<string, any>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.avgDailyDemand === "string")).toBe(true);
  });

  it("exit flow: an explainable suggestion converts cleanly into a PO (idempotent, single tx)", async () => {
    fx.supplierId = (await createSupplier(stock, "SUP-P3", [
      { variantId: fx.variantB, supplierSku: "BW-500", unitCost: "4.7500", isDefault: true },
      { variantId: fx.variantA, supplierSku: "BW-330", unitCost: "5.0000" },
    ])).id;

    const suggestions = await evaluate(stock, fx.branchA1);
    const forB = suggestions.find((s) => s.variantId === fx.variantB) as Record<string, any>;
    expect(forB.suggestedSupplierId).toBe(fx.supplierId);
    expect(forB.unitCost).toBe("4.7500");

    const created = await request(app.getHttpServer())
      .post("/v1/purchase-orders")
      .set(auth(owner))
      .send({ clientOperationId: "po-1", suggestionId: forB.id });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(created.body.supplierId).toBe(fx.supplierId);
    expect(created.body.lines).toHaveLength(1);
    expect(created.body.lines[0].variantId).toBe(fx.variantB);
    expect(created.body.lines[0].quantity).toBe("24.0000");
    expect(created.body.lines[0].unitCost).toBe("4.7500");
    const poId = created.body.id as string;
    fx.poId = poId;

    // The suggestion flipped to converted in the SAME transaction.
    const converted = await request(app.getHttpServer())
      .get("/v1/reorder/suggestions")
      .query({ branchId: fx.branchA1, status: "converted" })
      .set(auth(stock));
    expect(converted.body.suggestions.some((s: any) => s.id === forB.id && s.convertedPoId === poId)).toBe(true);

    // Replaying the create returns the same PO, never a duplicate.
    const replay = await request(app.getHttpServer())
      .post("/v1/purchase-orders")
      .set(auth(owner))
      .send({ clientOperationId: "po-1", suggestionId: forB.id });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(poId);

    // The evaluator does not resurrect a converted suggestion.
    const open = await openSuggestions(stock, fx.branchA1);
    expect(open.some((s) => s.variantId === fx.variantB)).toBe(false);

    // A stock controller (no purchase.po.approve) cannot send; the owner can.
    const stockSend = await request(app.getHttpServer()).post(`/v1/purchase-orders/${poId}/send`).set(auth(stock));
    expect(stockSend.status).toBe(403);
    const sent = await request(app.getHttpServer()).post(`/v1/purchase-orders/${poId}/send`).set(auth(owner));
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe("sent");
    expect(sent.body.sentAt).toBeDefined();
  });

  it("a sent PO is immutable at the database level", async () => {
    const poId = fx.poId as string;
    for (const sql of [
      `UPDATE purchase_orders SET notes = 'hacked' WHERE id = '${poId}'`,
      `DELETE FROM purchase_orders WHERE id = '${poId}'`,
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

  it("partial receipts: GRN against the PO updates received quantities; overshoot is rejected", async () => {
    const poId = fx.poId as string;

    const partial = await postGrn(stock, "grn-po-1", [{ variantId: fx.variantB, quantity: "10", unitCost: "4.7500" }], poId);
    expect(partial.status).toBe("posted");
    expect(partial.poId).toBe(poId);

    const poAfterPartial = await request(app.getHttpServer()).get(`/v1/purchase-orders/${poId}`).set(auth(owner));
    expect(poAfterPartial.body.status).toBe("partially_received");
    expect(poAfterPartial.body.lines[0].receivedQuantity).toBe("10.0000");
    expect(poAfterPartial.body.lines[0].outstandingQuantity).toBe("14.0000");

    // Ledger + PO bookkeeping committed together (Invariant 3): stock moved.
    const balances = await request(app.getHttpServer())
      .get("/v1/stock/balances")
      .query({ branchId: fx.branchA1 })
      .set(auth(owner));
    const row = balances.body.balances.find((b: any) => b.variantId === fx.variantB);
    expect(row.quantityOnHand).toBe("10.0000");

    // Overshoot (10 received + 15 > 24 ordered) → clean 400, nothing written.
    const over = await request(app.getHttpServer())
      .post("/v1/grns")
      .set(auth(stock))
      .send({ clientOperationId: "grn-po-over", branchId: fx.branchA1, poId, lines: [{ variantId: fx.variantB, quantity: "15", unitCost: "4.7500" }] });
    expect(over.status).toBe(400);

    // Complete the order with the remaining 14.
    const full = await postGrn(stock, "grn-po-2", [{ variantId: fx.variantB, quantity: "14", unitCost: "4.7500" }], poId);
    expect(full.status).toBe("posted");

    const poDone = await request(app.getHttpServer()).get(`/v1/purchase-orders/${poId}`).set(auth(owner));
    expect(poDone.body.status).toBe("received");
    expect(poDone.body.lines[0].receivedQuantity).toBe("24.0000");
    expect(poDone.body.lines[0].outstandingQuantity).toBe("0.0000");

    // Re-posting the same GRN (dropped-response retry) is idempotent.
    const grns = await request(app.getHttpServer()).get("/v1/grns").query({ branchId: fx.branchA1 }).set(auth(stock));
    const grnPo2 = (grns.body.grns as any[]).find((g) => g.documentNo === full.documentNo);
    const repost = await request(app.getHttpServer()).post(`/v1/grns/${grnPo2.id}/post`).set(auth(stock));
    expect(repost.status).toBe(201);
    const poAfterRepost = await request(app.getHttpServer()).get(`/v1/purchase-orders/${poId}`).set(auth(owner));
    expect(poAfterRepost.body.lines[0].receivedQuantity).toBe("24.0000");
  });

  it("supplier scorecard: derived metrics (PO count, received value)", async () => {
    const res = await request(app.getHttpServer()).get("/v1/suppliers/scorecard").set(auth(owner));
    expect(res.status).toBe(200);
    const row = (res.body.scorecard as Record<string, any>[]).find((s) => s.supplierId === fx.supplierId) as Record<string, any>;
    expect(row).toBeDefined();
    expect(row.poCount).toBe(1);
    expect(row.fullyReceivedCount).toBe(1);
    expect(row.totalOrderedValue).toBe("114.0000"); // 24 × 4.75
    expect(row.totalReceivedValue).toBe("114.0000");
    expect(Number(row.avgLeadTimeDays)).toBe(0); // received instantly
    expect(row.onTimeRate).toBeNull(); // no expected delivery date set
  });

  it("webhooks: PO events are delivered signed (HMAC-verified); permissions + RLS hold", async () => {
    const secret = "test-webhook-secret";
    const hook = await request(app.getHttpServer())
      .post("/v1/webhooks")
      .set(auth(owner))
      .send({ url: `http://127.0.0.1:${webhookPort}/hook`, secret, events: ["po.sent", "po.received"] });
    expect(hook.status).toBe(201);
    const webhookId = hook.body.id as string;
    expect(hook.body.secret).toBe(secret);

    // A cashier cannot manage webhooks.
    const denied = await request(app.getHttpServer()).post("/v1/webhooks").set(auth(cashier)).send({ url: "http://x.test" });
    expect(denied.status).toBe(403);

    // variantA (rule: point 6, stock 0) is an open suggestion → convert to a PO.
    await evaluate(stock, fx.branchA1);
    const open = await openSuggestions(stock, fx.branchA1);
    const forA = open.find((s) => s.variantId === fx.variantA) as Record<string, any>;
    expect(forA).toBeDefined();
    const po2 = await request(app.getHttpServer())
      .post("/v1/purchase-orders")
      .set(auth(owner))
      .send({ clientOperationId: "po-2", suggestionId: forA.id });
    expect(po2.status).toBe(201);

    // Send → a `po.sent` delivery arrives with a valid HMAC signature.
    const sent2 = await request(app.getHttpServer()).post(`/v1/purchase-orders/${po2.body.id}/send`).set(auth(owner));
    expect(sent2.status).toBe(201);
    const sentDelivery = captured.find((c) => c.event === "po.sent");
    expect(sentDelivery).toBeDefined();
    const match = /^t=(\d+);v1=([0-9a-f]+)$/.exec(sentDelivery!.signature);
    expect(match).not.toBeNull();
    const expected = createHmac("sha256", secret).update(`${match![1]}.${sentDelivery!.body}`).digest("hex");
    expect(match![2]).toBe(expected);
    expect(JSON.parse(sentDelivery!.body).event).toBe("po.sent");
    expect(JSON.parse(sentDelivery!.body).data.poId).toBe(po2.body.id);

    // Fully receiving the PO (all 12 ordered) fires `po.received`.
    await postGrn(stock, "grn-po-3", [{ variantId: fx.variantA, quantity: "12", unitCost: "5.0000" }], po2.body.id);
    const receivedDelivery = captured.find((c) => c.event === "po.received");
    expect(receivedDelivery).toBeDefined();

    // Deliveries are listed per webhook.
    const deliveries = await request(app.getHttpServer()).get(`/v1/webhooks/${webhookId}/deliveries`).set(auth(owner));
    expect(deliveries.status).toBe(200);
    expect((deliveries.body.deliveries as any[]).filter((d) => d.status === "success").length).toBeGreaterThanOrEqual(2);

    // Cross-tenant: org B sees no webhooks and cannot touch org A's.
    const bossB = await login(app, "boss@evilcorp.test");
    const seen = await request(app.getHttpServer()).get("/v1/webhooks").set(auth(bossB));
    expect(seen.body.webhooks).toHaveLength(0);
    const notFound = await request(app.getHttpServer()).delete(`/v1/webhooks/${webhookId}`).set(auth(bossB));
    expect(notFound.status).toBe(404);
  });

  it("the ledger reconciles exactly at the end of the Phase 3 flows (delta 0 everywhere)", async () => {
    const deltas = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT * FROM v_stock_reconciliation WHERE org_id = $1 AND delta <> 0", [fx.orgA]),
    );
    expect(deltas.rows.length).toBe(0);
  });

  it("every privileged Phase 3 action lands in audit_log", async () => {
    const audit = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT action FROM audit_log WHERE org_id = $1", [fx.orgA]),
    );
    const actions = audit.rows.map((r) => r.action as string);
    for (const expected of ["reorder.rule.upsert", "reorder.evaluate", "po.create", "po.send", "webhook.create", "grn.post"]) {
      expect(actions).toContain(expected);
    }
  });
});

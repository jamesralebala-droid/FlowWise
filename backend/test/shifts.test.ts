import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("shifts & cash-up (Phase 1)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let cashier: LoginResult;
  let owner: LoginResult;
  let auditor: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    cashier = await login(app, "cashier@flowwise.demo");
    owner = await login(app, "owner@flowwise.demo");
    auditor = await login(app, "auditor@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const openShift = (token: string, body?: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/v1/shifts")
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: fx.branchA1, openingCash: "200.00", ...body });

  const closeShift = (token: string, shiftId: string, declared?: Record<string, string>) =>
    request(app.getHttpServer())
      .post(`/v1/shifts/${shiftId}/close`)
      .set("Authorization", `Bearer ${token}`)
      .send({ declaredCash: "300.00", declaredCard: "0", declaredMobileMoney: "0", declaredCredit: "0", declaredOther: "0", ...declared });

  const saleBody = (clientOperationId: string, shiftId: string) => ({
    clientOperationId,
    branchId: fx.branchA1,
    shiftId,
    lines: [
      { variantId: fx.variantA, quantity: "2" },
      { variantId: fx.variantB, quantity: "1" },
    ],
    tenders: [{ tenderType: "cash", amount: "30.00" }],
  });

  const inventoryOf = async (variantId: string) => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query(
        "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
        [fx.orgA, fx.branchA1, variantId],
      ),
    );
    return r.rows.length ? (r.rows[0].quantity_on_hand as string) : "0.0000";
  };

  it("a cashier opens a shift with the opening float", async () => {
    const res = await openShift(cashier.access_token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.branchId).toBe(fx.branchA1);
    expect(res.body.openingCash).toBe("200.0000");
    expect(res.body.userId).toBe(fx.cashierA);
    expect(res.body.closedAt).toBeNull();
    // free the branch for the next test
    await closeShift(owner.access_token, res.body.id);
  });

  it("only one open shift per branch is allowed", async () => {
    const first = await openShift(cashier.access_token);
    expect(first.status).toBe(201);
    const second = await openShift(cashier.access_token, { notes: "should fail" });
    expect(second.status).toBe(409);
    // free the branch for the next test
    await closeShift(owner.access_token, first.body.id);
  });

  it("sales attach to the open shift; close computes expected totals and variance server-side", async () => {
    const shift = await openShift(cashier.access_token);
    expect(shift.status).toBe(201);
    const shiftId = shift.body.id as string;

    const s1 = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("shift-sale-1", shiftId));
    expect(s1.status).toBe(201);
    expect(s1.body.shiftId).toBe(shiftId);
    const s2 = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("shift-sale-2", shiftId));
    expect(s2.status).toBe(201);
    expect(await inventoryOf(fx.variantA)).toBe("-4.0000");

    const close = await closeShift(owner.access_token, shiftId);
    expect(close.status).toBe(201);
    const c = close.body;
    expect(c.status).toBe("closed");
    expect(c.closedAt).toBeTruthy();
    // 200 float + 27.36 + 27.36 sales; cash expected = 200 + 30 + 30 tendered.
    expect(c.expectedTotal).toBe("254.7200");
    expect(c.expectedCash).toBe("260.0000");
    // declared 300 total − expected 254.72
    expect(c.variance).toBe("45.2800");
    expect(c.declaredCash).toBe("300.0000");
  });

  it("closing an already-closed shift is idempotent", async () => {
    const shift = await openShift(cashier.access_token);
    const shiftId = shift.body.id as string;
    const first = await closeShift(owner.access_token, shiftId);
    expect(first.status).toBe(201);

    const replay = await closeShift(owner.access_token, shiftId);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(shiftId);
    expect(replay.body.status).toBe("closed");
    expect(replay.body.variance).toBe(first.body.variance);
    expect(replay.body.expectedTotal).toBe(first.body.expectedTotal);
  });

  it("a closed shift rejects new sales", async () => {
    const shift = await openShift(cashier.access_token);
    const shiftId = shift.body.id as string;
    await closeShift(owner.access_token, shiftId);

    const res = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send(saleBody("shift-sale-closed", shiftId));
    expect(res.status).toBe(400);
  });

  it("RLS: org B cannot see or close org A's shift", async () => {
    const shift = await openShift(cashier.access_token);
    const shiftId = shift.body.id as string;

    const boss = await login(app, "boss@evilcorp.test");
    const get = await request(app.getHttpServer())
      .get(`/v1/shifts/${shiftId}`)
      .set("Authorization", `Bearer ${boss.access_token}`);
    expect(get.status).toBe(404);

    const close = await closeShift(boss.access_token, shiftId);
    expect(close.status).toBe(404);
    // free the branch for the next test
    await closeShift(owner.access_token, shiftId);
  });

  it("closed shifts are immutable at the database level", async () => {
    const shift = await openShift(cashier.access_token);
    const shiftId = shift.body.id as string;
    await closeShift(owner.access_token, shiftId);

    for (const sql of [
      `UPDATE shifts SET variance = 0 WHERE id = '${shiftId}'`,
      `DELETE FROM shifts WHERE id = '${shiftId}'`,
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

  it("permissions: an auditor cannot open a shift; the owner can list shifts", async () => {
    const denied = await openShift(auditor.access_token);
    expect(denied.status).toBe(403);

    const list = await request(app.getHttpServer())
      .get(`/v1/shifts?branchId=${fx.branchA1}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.shifts)).toBe(true);
    expect(list.body.shifts.length).toBeGreaterThan(0);
  });
});

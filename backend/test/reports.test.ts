import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("basic reports (Phase 1)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let auditor: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    auditor = await login(app, "auditor@flowwise.demo");
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

  const makeSale = async (clientOperationId: string) =>
    request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send(saleBody(clientOperationId));

  const summary = (token: string, q?: string) =>
    request(app.getHttpServer())
      .get(`/v1/reports/sales-summary${q ?? ""}`)
      .set("Authorization", `Bearer ${token}`);

  it("sales-summary totals match the completed sales exactly", async () => {
    const s1 = await makeSale("rep-sale-1");
    expect(s1.status).toBe(201);
    const s2 = await makeSale("rep-sale-2");
    expect(s2.status).toBe(201);

    const res = await summary(owner.access_token);
    expect(res.status).toBe(200);
    const t = res.body.totals;
    expect(t.salesCount).toBe(2);
    expect(t.subtotal).toBe("48.0000"); // 24 + 24
    expect(t.taxTotal).toBe("6.7200"); // 3.36 + 3.36
    expect(t.total).toBe("54.7200"); // 27.36 + 27.36
    expect(t.refundTotal).toBe("0.0000");
    expect(t.netTotal).toBe("54.7200");
    expect(t.averageSale).toBe("27.3600");

    expect(res.body.tenders).toEqual([
      { tenderType: "cash", amount: "60.0000", count: 2 },
    ]);
  });

  it("refunds are netted out of the totals", async () => {
    const sale = await makeSale("rep-sale-3");
    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${sale.body.id}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "rep-refund-3" });
    expect(refund.status).toBe(201);

    const res = await summary(owner.access_token);
    const t = res.body.totals;
    expect(t.salesCount).toBe(3);
    expect(t.total).toBe("82.0800"); // 3 × 27.36
    expect(t.refundTotal).toBe("27.3600");
    expect(t.netTotal).toBe("54.7200");
  });

  it("the branch filter scopes the report; an unknown branch is rejected", async () => {
    const res = await summary(owner.access_token, `?branchId=${fx.branchA1}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.salesCount).toBe(3);

    const other = await summary(owner.access_token, `?branchId=${fx.branchA2}`);
    expect(other.status).toBe(200);
    expect(other.body.totals.salesCount).toBe(0);
    expect(other.body.totals.total).toBe("0.0000");

    const unknown = await summary(owner.access_token, `?branchId=${fx.branchB1}`);
    expect(unknown.status).toBe(400);
  });

  it("daily-sales buckets by day in the org timezone", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/reports/daily-sales")
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.daily[0].salesCount).toBe(3);
    expect(res.body.daily[0].total).toBe("82.0800");
    expect(typeof res.body.daily[0].day).toBe("string");
  });

  it("RLS: org B's report sees zero rows of org A's data", async () => {
    const boss = await login(app, "boss@evilcorp.test");
    const res = await summary(boss.access_token);
    expect(res.status).toBe(200);
    expect(res.body.totals.salesCount).toBe(0);
    expect(res.body.totals.total).toBe("0.0000");
    expect(res.body.tenders).toEqual([]);
  });

  it("an auditor (reports.read) can read the reports", async () => {
    const res = await summary(auditor.access_token);
    expect(res.status).toBe(200);
    expect(res.body.totals.salesCount).toBe(3);
  });
});

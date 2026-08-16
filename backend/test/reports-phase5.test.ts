import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("Phase 5 reports: valuation, margin, top products", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let auditor: LoginResult;
  let cashier: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);

    // Opening stock on branch A1 with landed costs: A 100 @ 5.00, B 50 @ 6.00.
    await fx.db.withContext({ orgId: fx.orgA, userId: fx.stockA }, async (tx) => {
      for (const r of [
        { variant: fx.variantA, qty: "100", cost: "5.00" },
        { variant: fx.variantB, qty: "50", cost: "6.00" },
      ]) {
        await tx.query(
          `INSERT INTO stock_ledger
             (org_id, branch_id, variant_id, movement_type, quantity, unit_cost,
              reference_type, reference_id, idempotency_key, created_by_user_id)
           VALUES ($1, $2, $3, 'opening', $4::numeric(14,4), $5::numeric(14,4),
                   'import', NULL, $6, $7)`,
          [fx.orgA, fx.branchA1, r.variant, r.qty, r.cost, `p5:opening:${r.variant}`, fx.stockA],
        );
      }
    });

    owner = await login(app, "owner@flowwise.demo");
    auditor = await login(app, "auditor@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const makeSale = async (token: string, clientOperationId: string) =>
    request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({
        clientOperationId,
        branchId: fx.branchA1,
        lines: [
          { variantId: fx.variantA, quantity: "2" },
          { variantId: fx.variantB, quantity: "1" },
        ],
        tenders: [{ tenderType: "cash", amount: "30.00" }],
      });

  it("stock-valuation prices on-hand stock at latest landed cost", async () => {
    const s1 = await makeSale(owner.access_token, "p5-sale-1");
    expect(s1.status).toBe(201);
    const s2 = await makeSale(owner.access_token, "p5-sale-2");
    expect(s2.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get("/v1/reports/stock-valuation")
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(res.status).toBe(200);
    // Sold 4 × A and 2 × B: A 96 @ 5 = 480, B 48 @ 6 = 288 → 768.
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].branchName).toBe("Main Branch");
    expect(res.body.rows[0].value).toBe("768.0000");
    expect(res.body.total).toBe("768.0000");

    const branch = await request(app.getHttpServer())
      .get(`/v1/reports/stock-valuation?branchId=${fx.branchA2}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(branch.status).toBe(200);
    expect(branch.body.rows).toEqual([]);
    expect(branch.body.total).toBe("0.0000");
  });

  it("margin shows revenue, COGS and margin per variant", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/reports/margin")
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(res.status).toBe(200);

    const byName = new Map(
      (res.body.rows as { productName: string; revenue: string; cogs: string; margin: string }[]).map((r) => [
        r.productName,
        r,
      ]),
    );
    const coke = byName.get("Coca-Cola");
    expect(coke?.revenue).toBe("30.0000"); // 4 × 7.50
    expect(coke?.cogs).toBe("20.0000"); // 4 × 5.00
    expect(coke?.margin).toBe("10.0000");

    const fanta = byName.get("Fanta Orange");
    expect(fanta?.revenue).toBe("18.0000"); // 2 × 9.00
    expect(fanta?.cogs).toBe("12.0000"); // 2 × 6.00
    expect(fanta?.margin).toBe("6.0000");
  });

  it("top-products ranks variants by revenue with an optional limit", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/reports/top-products?limit=1")
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].productName).toBe("Coca-Cola");
    expect(res.body.rows[0].revenue).toBe("30.0000");
  });

  it("reports.read gates the phase 5 endpoints", async () => {
    const auditorRes = await request(app.getHttpServer())
      .get("/v1/reports/stock-valuation")
      .set("Authorization", `Bearer ${auditor.access_token}`);
    expect(auditorRes.status).toBe(200);

    const cashierRes = await request(app.getHttpServer())
      .get("/v1/reports/margin")
      .set("Authorization", `Bearer ${cashier.access_token}`);
    expect(cashierRes.status).toBe(403);
  });
});

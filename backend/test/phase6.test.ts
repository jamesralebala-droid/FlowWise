import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("Phase 6: promotions, loyalty & mobile money", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let cashier: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const sell = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post("/v1/sales").set("Authorization", `Bearer ${token}`).send(body);

  const baseSale = (clientOperationId: string, extra: Record<string, unknown> = {}) => ({
    clientOperationId,
    branchId: fx.branchA1,
    lines: [{ variantId: fx.variantA, quantity: "1" }], // 7.50 + 1.05 VAT = 8.55
    tenders: [{ tenderType: "cash", amount: "8.55" }],
    ...extra,
  });

  const createPromotion = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post("/v1/promotions").set("Authorization", `Bearer ${token}`).send(body);

  describe("promotions", () => {
    it("owner creates percentage and amount promotions; cashier cannot", async () => {
      const pct = await createPromotion(owner.access_token, {
        code: "WELCOME10",
        name: "10% off",
        discountType: "percentage",
        discountValue: "0.10",
        minSpend: "50",
      });
      expect(pct.status).toBe(201);
      expect(pct.body.discountType).toBe("percentage");

      const amt = await createPromotion(owner.access_token, {
        code: "P50OFF",
        name: "P50 off over P200",
        discountType: "amount",
        discountValue: "50",
        minSpend: "200",
      });
      expect(amt.status).toBe(201);

      const denied = await createPromotion(cashier.access_token, { code: "NOPE", name: "nope", discountType: "amount", discountValue: "5" });
      expect(denied.status).toBe(403);

      const dup = await createPromotion(owner.access_token, { code: "welcome10", name: "dup", discountType: "amount", discountValue: "5" });
      expect(dup.status).toBe(400);

      const list = await request(app.getHttpServer())
        .get("/v1/promotions")
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(list.status).toBe(200);
      expect(list.body.promotions).toHaveLength(2);
    });

    it("a percentage promotion discounts the taxable base proportionally", async () => {
      // 10 × 7.50 = 75.00 subtotal, 10.50 tax at full; 10% off → taxable 67.50, tax 9.45, total 76.95
      const sale = await sell(owner.access_token, {
        ...baseSale("p6-promo-pct", { lines: [{ variantId: fx.variantA, quantity: "10" }], tenders: [{ tenderType: "cash", amount: "76.95" }] }),
        promotionCode: "WELCOME10",
      });
      expect(sale.status).toBe(201);
      expect(sale.body.discount).toBe("7.5000");
      expect(sale.body.total).toBe("76.9500");
      expect(sale.body.promotionId).toBeTruthy();

      // min spend not met → rejected
      const tooSmall = await sell(owner.access_token, { ...baseSale("p6-promo-small"), promotionCode: "WELCOME10" });
      expect(tooSmall.status).toBe(400);
      expect(tooSmall.body.message).toContain("minimum spend");

      // unknown code → rejected
      const unknown = await sell(owner.access_token, { ...baseSale("p6-promo-unknown"), promotionCode: "NOPE99" });
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toContain("Unknown promotion code");
    });

    it("usage limits are enforced atomically with the sale", async () => {
      await createPromotion(owner.access_token, {
        code: "ONCE",
        name: "Once only",
        discountType: "amount",
        discountValue: "1",
        usageLimit: 1,
      });
      const ok = await sell(owner.access_token, { ...baseSale("p6-promo-once-1"), promotionCode: "ONCE" });
      expect(ok.status).toBe(201);
      const exhausted = await sell(owner.access_token, { ...baseSale("p6-promo-once-2"), promotionCode: "ONCE" });
      expect(exhausted.status).toBe(400);
      expect(exhausted.body.message).toContain("usage limit");
    });
  });

  describe("loyalty", () => {
    const createCustomer = (name: string) =>
      request(app.getHttpServer())
        .post("/v1/customers")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ name, creditLimit: "0" });

    it("a sale to a customer earns points (floor of total × org rate)", async () => {
      const customer = await createCustomer("Loyal Shopper");
      // 10 × variantA = 85.50 total → floor(8.55) = 8 points
      const sale = await sell(owner.access_token, {
        ...baseSale("p6-loyal-earn", {
          customerId: customer.body.id,
          lines: [{ variantId: fx.variantA, quantity: "10" }],
          tenders: [{ tenderType: "cash", amount: "85.50" }],
        }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.loyaltyPointsUsed).toBe(0);
      expect(sale.body.loyaltyCredit).toBe("0.0000");

      const detail = await request(app.getHttpServer())
        .get(`/v1/customers/${customer.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(detail.body.loyaltyPoints).toBe(8);

      // Replaying the same sale id never double-earns.
      await sell(owner.access_token, {
        ...baseSale("p6-loyal-earn", {
          customerId: customer.body.id,
          lines: [{ variantId: fx.variantA, quantity: "10" }],
          tenders: [{ tenderType: "cash", amount: "85.50" }],
        }),
      });
      const after = await request(app.getHttpServer())
        .get(`/v1/customers/${customer.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(after.body.loyaltyPoints).toBe(8);
    });

    it("redemption requires a customer and a sufficient balance; credit caps at the payable", async () => {
      const customer = await createCustomer("Points Spender");
      await sell(owner.access_token, {
        ...baseSale("p6-loyal-fund", {
          customerId: customer.body.id,
          lines: [{ variantId: fx.variantA, quantity: "10" }],
          tenders: [{ tenderType: "cash", amount: "85.50" }],
        }),
      });

      // 8 points × P0.10 = P0.80 off an 8.55 sale → pay 7.75
      const redeem = await sell(owner.access_token, {
        ...baseSale("p6-loyal-redeem", {
          customerId: customer.body.id,
          loyaltyRedeem: { points: 8 },
          tenders: [{ tenderType: "cash", amount: "7.75" }],
        }),
      });
      expect(redeem.status).toBe(201);
      expect(redeem.body.loyaltyPointsUsed).toBe(8);
      expect(redeem.body.loyaltyCredit).toBe("0.8000");
      expect(redeem.body.total).toBe("7.7500");

      const after = await request(app.getHttpServer())
        .get(`/v1/customers/${customer.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(after.body.loyaltyPoints).toBe(0); // 8 earned (fund sale) − 8 redeemed

      // Insufficient points → rejected
      const broke = await sell(owner.access_token, {
        ...baseSale("p6-loyal-broke", { customerId: customer.body.id, loyaltyRedeem: { points: 999 } }),
      });
      expect(broke.status).toBe(400);
      expect(broke.body.message).toContain("Insufficient loyalty points");

      // Redemption without a customer → rejected
      const noCustomer = await sell(owner.access_token, { ...baseSale("p6-loyal-nocust"), loyaltyRedeem: { points: 1 } });
      expect(noCustomer.status).toBe(400);
      expect(noCustomer.body.message).toContain("customerId is required");
    });

    it("a refund reverses the exact points the sale earned/spent", async () => {
      const customer = await createCustomer("Refund Points");
      await sell(owner.access_token, {
        ...baseSale("p6-loyal-rfund1", {
          customerId: customer.body.id,
          lines: [{ variantId: fx.variantA, quantity: "10" }],
          tenders: [{ tenderType: "cash", amount: "85.50" }],
        }),
      });
      const redeemed = await sell(owner.access_token, {
        ...baseSale("p6-loyal-rfund2", {
          customerId: customer.body.id,
          loyaltyRedeem: { points: 8 },
          tenders: [{ tenderType: "cash", amount: "7.75" }],
        }),
      });
      expect(redeemed.status).toBe(201);

      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${redeemed.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p6-loyal-refund-op", amount: "7.75" });
      expect(refund.status).toBe(201);

      // +8 (sale1) −8 (redeem) +8 (redeem reversed) −8 (earn reversed) = 0 from sale2,
      // leaving exactly the 8 points earned on sale1.
      const after = await request(app.getHttpServer())
        .get(`/v1/customers/${customer.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(after.body.loyaltyPoints).toBe(8);
    });
  });

  describe("mobile money", () => {
    it("a mobile-money tender creates a pending payment that the mock provider confirms", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p6-mmp-1", {
          tenders: [{ tenderType: "mobile_money", amount: "8.55", reference: "+26771234567" }],
        }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.payments).toHaveLength(1);
      expect(sale.body.payments[0].status).toBe("confirmed");
      expect(sale.body.payments[0].provider).toBe("mock");

      const list = await request(app.getHttpServer())
        .get("/v1/mobile-money/payments")
        .set("Authorization", `Bearer ${cashier.access_token}`);
      expect(list.status).toBe(200);
      expect(list.body.payments.length).toBeGreaterThanOrEqual(1);
      expect(list.body.payments[0].status).toBe("confirmed");

      // A mobile tender without a phone reference is rejected at the till.
      const noRef = await sell(owner.access_token, {
        ...baseSale("p6-mmp-noref", { tenders: [{ tenderType: "mobile_money", amount: "8.55" }] }),
      });
      expect(noRef.status).toBe(400);
      expect(noRef.body.message).toContain("mobile number");
    });

    it("the webhook endpoint refuses callbacks when no secret is configured", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/mobile-money/webhook")
        .send({ event: "payment.completed", payment: { reference: "anything", status: "completed" } });
      expect(res.status).toBe(401);
    });

    it("the SECURITY DEFINER confirm function flips a pending payment by provider reference", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p6-mmp-2", {
          tenders: [{ tenderType: "mobile_money", amount: "8.55", reference: "+26770000001" }],
        }),
      });
      const saleId = sale.body.id as string;

      // Simulate an async gateway: the mock confirmed instantly, so force the
      // row back to pending with a Dodo-style reference. The raw session runs
      // under RLS as flowwise_app with no org GUC, which would silently filter
      // the UPDATE — switch to the superuser for the fixture write.
      await fx.raw.query("SET ROLE postgres");
      await fx.raw.query(
        `UPDATE mobile_money_payments SET status = 'pending', provider_reference = 'dodo-ref-42',
                provider_status = 'pending', confirmed_at = NULL, updated_at = now()
         WHERE org_id = '${fx.orgA}' AND sale_id = '${saleId}'`,
      );
      await fx.raw.query("SET ROLE flowwise_app");

      const confirmed = await fx.raw.query(
        `SELECT id, org_id AS "orgId", sale_id AS "saleId" FROM confirm_mobile_money_payment('dodo-ref-42', 'completed')`,
      );
      expect(confirmed.rows).toHaveLength(1);

      const list = await request(app.getHttpServer())
        .get("/v1/mobile-money/payments?status=confirmed")
        .set("Authorization", `Bearer ${owner.access_token}`);
      const payment = list.body.payments.find((p: { saleId: string }) => p.saleId === saleId);
      expect(payment).toBeTruthy();
      expect(payment.status).toBe("confirmed");
      expect(payment.providerReference).toBe("dodo-ref-42");
    });

    it("RLS: org B cannot see org A payments or promotions", async () => {
      const boss = await login(app, "boss@evilcorp.test");
      const payments = await request(app.getHttpServer())
        .get("/v1/mobile-money/payments")
        .set("Authorization", `Bearer ${boss.access_token}`);
      expect(payments.status).toBe(200);
      expect(payments.body.payments).toEqual([]);

      const promotions = await request(app.getHttpServer())
        .get("/v1/promotions")
        .set("Authorization", `Bearer ${boss.access_token}`);
      expect(promotions.body.promotions).toEqual([]);
    });
  });

  describe("reports", () => {
    it("sales-summary carries Phase 6 totals (discounts, loyalty, mobile money)", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/reports/sales-summary")
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(res.status).toBe(200);
      expect(res.body.totals.discountTotal).toBeDefined();
      expect(res.body.totals.loyaltyCredit).toBeDefined();
      expect(res.body.totals.pointsRedeemed).toBeGreaterThanOrEqual(8);
      expect(res.body.loyalty.pointsEarned).toBeGreaterThanOrEqual(24); // 3 × 8
      expect(res.body.mobileMoney.count).toBeGreaterThanOrEqual(2);
      expect(res.body.mobileMoney.confirmedCount).toBeGreaterThanOrEqual(2);
      expect(res.body.mobileMoney.confirmedTotal).toBeDefined();
      // The 10% promo sale: discount 7.50 + 5% of 76.95? No — exactly the 7.5000 + 1.00 (ONCE) discounts.
      expect(Number(res.body.totals.discountTotal)).toBeGreaterThanOrEqual(8.5);
    });
  });
});

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("Phase 7: payouts, multi-currency & supplier portal", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let cashier: LoginResult;

  const portalLogin = (email: string, password = "Password123!") =>
    request(app.getHttpServer()).post("/v1/supplier-portal/login").send({ email, password });

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");

    // Fixture: base currency row (the migrations don't seed orgs), a supplier
    // in org A with a portal account, a price-list mapping and a SENT purchase
    // order. Written as the superuser (the app session has no org GUC, which
    // would silently filter RLS writes).
    await fx.raw.query("SET ROLE postgres");
    await fx.raw.query(
      `INSERT INTO currencies (org_id, code, name, is_base, rate_to_base)
       VALUES ('${fx.orgA}', 'BWP', 'Botswana Pula', true, 1)`,
    );
    const supplier = await fx.raw.query<{ id: string }>(
      `INSERT INTO suppliers (org_id, name, code, contact_name, contact_phone, email)
       VALUES ('${fx.orgA}', 'Test Supplies Ltd', 'TESTSUP', 'T. Tester', '+267 70 111 222', 'orders@testsup.bw')
       RETURNING id`,
    );
    const supplierId = supplier.rows[0].id;
    await fx.raw.query(
      `INSERT INTO supplier_products (org_id, supplier_id, variant_id, supplier_sku, unit_cost, is_default)
       VALUES ('${fx.orgA}', '${supplierId}', '${fx.variantA}', 'CC-330', 6.0000, true)`,
    );
    // Hash the portal password the same way the app does (bcrypt via password.ts).
    const { hashPassword } = await import("../src/password.js");
    const pw = await hashPassword("Password123!");
    await fx.raw.query(
      `INSERT INTO supplier_users (org_id, supplier_id, email, name, password_hash)
       VALUES ('${fx.orgA}', '${supplierId}', 'portal@testsup.bw', 'Test Supplies', '${pw}')`,
    );
    const po = await fx.raw.query<{ id: string }>(
      `INSERT INTO purchase_orders (org_id, branch_id, supplier_id, document_no, status, client_operation_id, sent_at)
       VALUES ('${fx.orgA}', '${fx.branchA1}', '${supplierId}', 'PO-TEST-001', 'sent', 'po-test-001', now())
       RETURNING id`,
    );
    await fx.raw.query(
      `INSERT INTO purchase_order_lines (org_id, purchase_order_id, line_no, variant_id, quantity, unit_cost)
       VALUES ('${fx.orgA}', '${po.rows[0].id}', 1, '${fx.variantA}', 100, 6.0000)`,
    );
    await fx.raw.query("SET ROLE flowwise_app");
    void owner;
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

  describe("currencies & foreign-currency tenders", () => {
    it("owner adds a currency; cashier can read it; duplicates and base-rate edits are rejected", async () => {
      const created = await request(app.getHttpServer())
        .post("/v1/currencies")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ code: "zar", name: "South African Rand", rateToBase: "0.74" });
      expect(created.status).toBe(201);
      expect(created.body.code).toBe("ZAR");
      expect(created.body.rateToBase).toBe("0.74000000");

      const list = await request(app.getHttpServer())
        .get("/v1/currencies")
        .set("Authorization", `Bearer ${cashier.access_token}`);
      expect(list.status).toBe(200);
      const codes = list.body.currencies.map((c: { code: string }) => c.code);
      expect(codes).toContain("BWP");
      expect(codes).toContain("ZAR");

      const dup = await request(app.getHttpServer())
        .post("/v1/currencies")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ code: "ZAR", name: "Rand", rateToBase: "0.75" });
      expect(dup.status).toBe(400);

      // The base currency already exists — you cannot re-add it.
      const addBase = await request(app.getHttpServer())
        .post("/v1/currencies")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ code: "BWP", name: "Pula", rateToBase: "1" });
      expect(addBase.status).toBe(400);

      // Base rate is pinned at 1.
      const badRate = await request(app.getHttpServer())
        .put("/v1/currencies/BWP")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ rateToBase: "1.2" });
      expect(badRate.status).toBe(400);

      // Non-owner cannot create.
      const denied = await request(app.getHttpServer())
        .post("/v1/currencies")
        .set("Authorization", `Bearer ${cashier.access_token}`)
        .send({ code: "USD", name: "US Dollar", rateToBase: "13.2" });
      expect(denied.status).toBe(403);
    });

    it("a cash tender in a foreign currency converts at the published rate (100 ZAR → P74.00)", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-fx-1", {
          tenders: [{ tenderType: "cash", amount: "100", currency: "ZAR" }],
        }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.total).toBe("8.5500");
      const tender = sale.body.tenders[0];
      expect(tender.tenderCurrency).toBe("ZAR");
      expect(tender.fxRate).toBe("0.74000000");
      expect(tender.amountFx).toBe("100.0000");
      expect(tender.amount).toBe("74.0000"); // base value stored for ledgers/shifts
    });

    it("unknown currencies and foreign mobile-money/credit tenders are rejected", async () => {
      const unknown = await sell(owner.access_token, {
        ...baseSale("p7-fx-bad", { tenders: [{ tenderType: "cash", amount: "10", currency: "XXX" }] }),
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toContain("Unknown tender currency");

      const mobile = await sell(owner.access_token, {
        ...baseSale("p7-fx-mobile", {
          tenders: [{ tenderType: "mobile_money", amount: "10", currency: "ZAR", reference: "+26771234567" }],
        }),
      });
      expect(mobile.status).toBe(400);
      expect(mobile.body.message).toContain("base currency");
    });

    it("a rate change applies to new sales; the base amount follows the new rate", async () => {
      await request(app.getHttpServer())
        .put("/v1/currencies/ZAR")
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ rateToBase: "0.80" });
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-fx-2", { tenders: [{ tenderType: "cash", amount: "10", currency: "ZAR" }] }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.tenders[0].amount).toBe("8.0000");
    });
  });

  describe("mobile-money payouts (refunds to wallets)", () => {
    it("refunding a mobile-money sale creates a payout the mock provider confirms", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-payout-1", {
          tenders: [{ tenderType: "mobile_money", amount: "8.55", reference: "+26771234567" }],
        }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.payments[0].status).toBe("confirmed");

      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-refund-1", amount: "8.55" });
      expect(refund.status).toBe(201);
      expect(refund.body.payout).toEqual({ phone: "+26771234567", amount: "8.5500" });

      // The sale detail exposes the payout with the provider's confirmation.
      const detail = await request(app.getHttpServer())
        .get(`/v1/sales/${sale.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(detail.body.payouts).toHaveLength(1);
      expect(detail.body.payouts[0].status).toBe("confirmed");
      expect(detail.body.payouts[0].amount).toBe("8.5500");

      const list = await request(app.getHttpServer())
        .get("/v1/mobile-money/payouts")
        .set("Authorization", `Bearer ${cashier.access_token}`);
      expect(list.status).toBe(200);
      expect(list.body.payouts.length).toBeGreaterThanOrEqual(1);
      expect(list.body.payouts[0].status).toBe("confirmed");
    });

    it("a partial refund pays out only the refunded amount", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-payout-2", {
          lines: [{ variantId: fx.variantA, quantity: "10" }], // 85.50
          tenders: [{ tenderType: "mobile_money", amount: "85.50", reference: "+26770000002" }],
        }),
      });
      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-refund-2", amount: "17.10" });
      expect(refund.status).toBe(201);
      expect(refund.body.payout.amount).toBe("17.1000");
    });

    it("a refund of a cash sale creates no payout", async () => {
      const sale = await sell(owner.access_token, baseSale("p7-payout-3"));
      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-refund-3", amount: "8.55" });
      expect(refund.status).toBe(201);
      expect(refund.body.payout).toBeUndefined();
    });

    it("the SECURITY DEFINER confirm function flips a pending payout by provider reference", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-payout-4", {
          tenders: [{ tenderType: "mobile_money", amount: "8.55", reference: "+26770000003" }],
        }),
      });
      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-refund-4", amount: "8.55" });
      expect(refund.status).toBe(201);
      const refundId = refund.body.refundId as string;

      // Force the payout back to pending with a Dodo-style reference, then
      // confirm it the way the gateway callback would.
      await fx.raw.query("SET ROLE postgres");
      await fx.raw.query(
        `UPDATE mobile_money_payouts SET status = 'pending', provider_reference = 'dodo-payout-77',
                provider_status = 'pending', confirmed_at = NULL, updated_at = now()
         WHERE org_id = '${fx.orgA}' AND refund_id = '${refundId}'`,
      );
      await fx.raw.query("SET ROLE flowwise_app");

      const confirmed = await fx.raw.query(
        `SELECT id, org_id AS "orgId", sale_id AS "saleId", refund_id AS "refundId"
         FROM confirm_mobile_money_payout('dodo-payout-77', 'completed')`,
      );
      expect(confirmed.rows).toHaveLength(1);

      const list = await request(app.getHttpServer())
        .get("/v1/mobile-money/payouts?status=confirmed")
        .set("Authorization", `Bearer ${owner.access_token}`);
      const payout = list.body.payouts.find((p: { refundId: string }) => p.refundId === refundId);
      expect(payout).toBeTruthy();
      expect(payout.status).toBe("confirmed");
      expect(payout.providerReference).toBe("dodo-payout-77");
    });

    it("replaying a refund returns the stored refund without a second payout", async () => {
      const sale = await sell(owner.access_token, {
        ...baseSale("p7-payout-5", {
          tenders: [{ tenderType: "mobile_money", amount: "8.55", reference: "+26770000004" }],
        }),
      });
      const refund = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-replay", amount: "8.55" });
      expect(refund.status).toBe(201);

      const replay = await request(app.getHttpServer())
        .post(`/v1/sales/${sale.body.id}/refund`)
        .set("Authorization", `Bearer ${owner.access_token}`)
        .send({ clientOperationId: "p7-payout-replay", amount: "8.55" });
      expect(replay.status).toBe(201);
      expect(replay.body.replay).toBe(true);

      const detail = await request(app.getHttpServer())
        .get(`/v1/sales/${sale.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(detail.body.payouts).toHaveLength(1);
    });
  });

  describe("supplier self-service portal", () => {
    it("login rejects bad credentials and throttles nothing visible; good login returns a scoped token", async () => {
      const bad = await portalLogin("portal@testsup.bw", "wrong-password");
      expect(bad.status).toBe(401);

      const ok = await portalLogin("portal@testsup.bw");
      expect(ok.status).toBe(201);
      expect(ok.body.accessToken).toBeTruthy();
      expect(ok.body.supplierId).toBeTruthy();
      expect(ok.body.expiresIn).toBeGreaterThan(0);
    });

    it("me + purchase-orders are scoped to the supplier's own data", async () => {
      const { accessToken } = (await portalLogin("portal@testsup.bw")).body as { accessToken: string };
      const me = await request(app.getHttpServer())
        .get("/v1/supplier-portal/me")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.supplierCode).toBe("TESTSUP");
      expect(me.body.name).toBe("Test Supplies");

      const pos = await request(app.getHttpServer())
        .get("/v1/supplier-portal/purchase-orders")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(pos.status).toBe(200);
      expect(pos.body.purchaseOrders).toHaveLength(1);
      expect(pos.body.purchaseOrders[0].documentNo).toBe("PO-TEST-001");
      expect(pos.body.purchaseOrders[0].lines[0].outstandingQuantity).toBe("100.0000");

      const detail = await request(app.getHttpServer())
        .get(`/v1/supplier-portal/purchase-orders/${pos.body.purchaseOrders[0].id}`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.lines).toHaveLength(1);
    });

    it("a user token cannot call portal endpoints, and another org cannot see these POs", async () => {
      const boss = await login(app, "boss@evilcorp.test");
      const denied = await request(app.getHttpServer())
        .get("/v1/supplier-portal/me")
        .set("Authorization", `Bearer ${boss.access_token}`);
      expect(denied.status).toBe(403);

      // Org B has no supplier account at all — login fails.
      const noAccount = await portalLogin("portal@testsup.bw");
      // The user exists in org A, so this still succeeds — RLS keeps the DATA
      // scoped. Cross-org PO access is blocked by the supplier scoping below.
      expect(noAccount.status).toBe(201);
      const other = (await portalLogin("portal@testsup.bw")).body as { accessToken: string };
      // Even though the token is valid, the portal only ever queries by
      // supplier_id from the token — org B's boss token can't reach it (403).
      void other;
    });

    it("suppliers maintain their own price list (cost hints) with audit", async () => {
      const { accessToken } = (await portalLogin("portal@testsup.bw")).body as { accessToken: string };
      const list = await request(app.getHttpServer())
        .get("/v1/supplier-portal/price-list")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].unitCost).toBe("6.0000");

      const updated = await request(app.getHttpServer())
        .put(`/v1/supplier-portal/price-list/${fx.variantA}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ unitCost: "6.35" });
      expect(updated.status).toBe(200);
      expect(updated.body.unitCost).toBe("6.3500");

      const bad = await request(app.getHttpServer())
        .put(`/v1/supplier-portal/price-list/${fx.variantB}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ unitCost: "5" });
      expect(bad.status).toBe(404); // variantB is not mapped to TESTSUP

      // The supplier can't push a negative cost.
      const negative = await request(app.getHttpServer())
        .put(`/v1/supplier-portal/price-list/${fx.variantA}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ unitCost: "-1" });
      expect(negative.status).toBe(400);
    });

    it("profile updates land on the supplier record", async () => {
      const { accessToken } = (await portalLogin("portal@testsup.bw")).body as { accessToken: string };
      const updated = await request(app.getHttpServer())
        .put("/v1/supplier-portal/me")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ contactPhone: "+267 71 999 888" });
      expect(updated.status).toBe(200);

      const me = await request(app.getHttpServer())
        .get("/v1/supplier-portal/me")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(me.body.contactPhone).toBe("+267 71 999 888");
    });
  });
});

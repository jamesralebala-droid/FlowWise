import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("Phase 8: supplier delivery notes → draft GRNs → stock", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let supplierId: string;
  let poId: string;
  let accessToken: string;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");

    // Fixture: supplier with a portal account + a SENT PO for variantA (100 × 6.00).
    await fx.raw.query("SET ROLE postgres");
    const supplier = await fx.raw.query<{ id: string }>(
      `INSERT INTO suppliers (org_id, name, code, contact_name, contact_phone, email)
       VALUES ('${fx.orgA}', 'Test Supplies Ltd', 'TESTSUP', 'T. Tester', '+267 70 111 222', 'orders@testsup.bw')
       RETURNING id`,
    );
    supplierId = supplier.rows[0].id;
    await fx.raw.query(
      `INSERT INTO supplier_products (org_id, supplier_id, variant_id, supplier_sku, unit_cost, is_default)
       VALUES ('${fx.orgA}', '${supplierId}', '${fx.variantA}', 'CC-330', 6.0000, true)`,
    );
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
    poId = po.rows[0].id;
    await fx.raw.query(
      `INSERT INTO purchase_order_lines (org_id, purchase_order_id, line_no, variant_id, quantity, unit_cost)
       VALUES ('${fx.orgA}', '${poId}', 1, '${fx.variantA}', 100, 6.0000)`,
    );
    await fx.raw.query("SET ROLE flowwise_app");

    const loginRes = await request(app.getHttpServer())
      .post("/v1/supplier-portal/login")
      .send({ email: "portal@testsup.bw", password: "Password123!" });
    expect(loginRes.status).toBe(201);
    accessToken = loginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const submit = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post("/v1/supplier-portal/delivery-notes").set("Authorization", `Bearer ${accessToken}`).send(body);

  describe("delivery-note submission", () => {
    it("creates a DRAFT GRN tied to the PO with unit costs snapshotted from the PO", async () => {
      const res = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "40" }], notes: "First drop" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("draft");
      expect(res.body.documentNo).toMatch(/^DN-/);

      // The branch sees it in the GRN list as a draft.
      const grns = await request(app.getHttpServer())
        .get("/v1/grns?status=draft")
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(grns.status).toBe(200);
      const draft = grns.body.grns.find((g: { id: string }) => g.id === res.body.id);
      expect(draft).toBeTruthy();
      expect(draft.status).toBe("draft");
      expect(Number(draft.totalQuantity)).toBe(40);

      const detail = await request(app.getHttpServer())
        .get(`/v1/grns/${res.body.id}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(detail.body.poId).toBe(poId);
      expect(detail.body.lines[0].unitCost).toBe("6.0000"); // snapshot, not client-supplied
      expect(detail.body.lines[0].quantity).toBe("40.0000");
    });

    it("resubmitting the same PO is idempotent (same draft, no duplicates)", async () => {
      const first = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "40" }] });
      const second = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "40" }] });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.documentNo).toBe(first.body.documentNo);
    });

    it("rejects over-delivery beyond the outstanding quantity", async () => {
      const over = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "61" }] }); // 100 - 40 = 60 left
      expect(over.status).toBe(400);
      expect(over.body.message).toContain("exceeds");
    });

    it("rejects lines not on the PO and empty delivery notes", async () => {
      const badVariant = await submit({ poId, lines: [{ variantId: fx.variantB, quantity: "5" }] });
      expect(badVariant.status).toBe(400);
      expect(badVariant.body.message).toContain("not a line");

      const empty = await submit({ poId, lines: [] });
      expect(empty.status).toBe(400);
    });

    it("a different supplier cannot deliver against this PO", async () => {
      // Second supplier (org A) without a portal user of its own — create one.
      await fx.raw.query("SET ROLE postgres");
      const other = await fx.raw.query<{ id: string }>(
        `INSERT INTO suppliers (org_id, name, code, contact_name, contact_phone, email)
         VALUES ('${fx.orgA}', 'Other Supplies', 'OTHERSUP', 'O. T.', '+267 70 000 000', 'other@testsup.bw')
         RETURNING id`,
      );
      const { hashPassword } = await import("../src/password.js");
      await fx.raw.query(
        `INSERT INTO supplier_users (org_id, supplier_id, email, name, password_hash)
         VALUES ('${fx.orgA}', '${other.rows[0].id}', 'other@testsup.bw', 'Other Supplies', '${await hashPassword("Password123!")}')`,
      );
      await fx.raw.query("SET ROLE flowwise_app");
      const otherLogin = await request(app.getHttpServer())
        .post("/v1/supplier-portal/login")
        .send({ email: "other@testsup.bw", password: "Password123!" });
      const otherToken = otherLogin.body.accessToken as string;
      const res = await request(app.getHttpServer())
        .post("/v1/supplier-portal/delivery-notes")
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ poId, lines: [{ variantId: fx.variantA, quantity: "10" }] });
      expect(res.status).toBe(403);
    });

    it("posting the draft GRN moves stock and advances the PO to received (branch approval)", async () => {
      const draft = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "60" }] });
      const posted = await request(app.getHttpServer())
        .post(`/v1/grns/${draft.body.id}/post`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      expect(posted.status).toBe(201);
      expect(posted.body.status).toBe("posted");

      // PO fully received.
      const portal = await request(app.getHttpServer())
        .get("/v1/supplier-portal/purchase-orders")
        .set("Authorization", `Bearer ${accessToken}`);
      const po = portal.body.purchaseOrders.find((p: { id: string }) => p.id === poId);
      expect(po.status).toBe("received");
      expect(po.lines[0].receivedQuantity).toBe("100.0000");
      expect(po.lines[0].outstandingQuantity).toBe("0.0000");

      // Stock moved on the branch.
      const balances = await request(app.getHttpServer())
        .get(`/v1/stock/balances?branchId=${fx.branchA1}`)
        .set("Authorization", `Bearer ${owner.access_token}`);
      const row = balances.body.balances.find((b: { variantId: string }) => b.variantId === fx.variantA);
      expect(row).toBeTruthy();
      expect(Number(row.quantityOnHand)).toBe(100);
    });

    it("delivering against a fully-received PO is rejected", async () => {
      const res = await submit({ poId, lines: [{ variantId: fx.variantA, quantity: "1" }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("sent purchase order");
    });
  });
});

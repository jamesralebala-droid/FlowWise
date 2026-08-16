import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("customer accounts & credit sales (Phase 5)", () => {
  let fx: Fixtures;
  let app: INestApplication;
  let owner: LoginResult;
  let cashier: LoginResult;
  let auditor: LoginResult;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    owner = await login(app, "owner@flowwise.demo");
    cashier = await login(app, "cashier@flowwise.demo");
    auditor = await login(app, "auditor@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  const createCustomer = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/v1/customers")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const creditSale = (token: string, customerId: string, clientOperationId: string, amount = "17.10") =>
    request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({
        clientOperationId,
        branchId: fx.branchA1,
        customerId,
        lines: [{ variantId: fx.variantA, quantity: "2" }], // 15.00 + 2.10 VAT = 17.10
        tenders: [{ tenderType: "credit", amount }],
      });

  it("creates and lists customers; permissions gate the write", async () => {
    const created = await createCustomer(owner.access_token, {
      name: "Maun Lodge Supplies",
      phone: "+267 76 123 456",
      email: "accounts@maunlodge.test",
      creditLimit: "1000",
    });
    expect(created.status).toBe(201);
    expect(created.body.creditLimit).toBe("1000.0000");
    expect(created.body.balance).toBe("0.0000");

    // A cashier may create customers at the till (customer.write).
    const byCashier = await createCustomer(cashier.access_token, {
      name: "Mma Kelebogile",
      email: "kelebogile@example.test",
    });
    expect(byCashier.status).toBe(201);

    // Duplicate email is rejected with a friendly error.
    const dup = await createCustomer(owner.access_token, { name: "Dup", email: "accounts@maunlodge.test" });
    expect(dup.status).toBe(400);

    // An auditor can read but never write.
    const denied = await createCustomer(auditor.access_token, { name: "Nope" });
    expect(denied.status).toBe(403);

    const list = await request(app.getHttpServer())
      .get("/v1/customers")
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(list.status).toBe(200);
    expect(list.body.customers).toHaveLength(2);
  });

  it("a credit sale creates a receivable in the same transaction", async () => {
    const customer = await createCustomer(owner.access_token, { name: "Credit Co", creditLimit: "500" });
    const sale = await creditSale(owner.access_token, customer.body.id, "cust-sale-1");
    expect(sale.status).toBe(201);

    const detail = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.balance).toBe("17.1000");

    // Replaying the same sale id never double-books the receivable.
    const replay = await creditSale(owner.access_token, customer.body.id, "cust-sale-1");
    expect(replay.status).toBe(201);
    const after = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(after.body.balance).toBe("17.1000");
  });

  it("credit limits are enforced: no limit and over-limit both rejected", async () => {
    const noLimit = await createCustomer(owner.access_token, { name: "Cash Only", creditLimit: "0" });
    const rejected = await creditSale(owner.access_token, noLimit.body.id, "cust-sale-nolimit");
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toContain("no credit limit");

    const smallLimit = await createCustomer(owner.access_token, { name: "Small Limit", creditLimit: "10" });
    const over = await creditSale(owner.access_token, smallLimit.body.id, "cust-sale-over");
    expect(over.status).toBe(400);
    expect(over.body.message).toContain("exceeds");

    // A credit sale without a customer is rejected outright.
    const noCustomer = await request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({
        clientOperationId: "cust-sale-nocust",
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantA, quantity: "1" }],
        tenders: [{ tenderType: "credit", amount: "8.55" }],
      });
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.message).toContain("customerId is required");
  });

  it("settlements reduce the balance and are replay-safe; cashier cannot settle", async () => {
    const customer = await createCustomer(owner.access_token, { name: "Settle Co", creditLimit: "500" });
    await creditSale(owner.access_token, customer.body.id, "cust-sale-2");

    // cashier lacks customer.settle (manager/owner two-step approval).
    const forbidden = await request(app.getHttpServer())
      .post(`/v1/customers/${customer.body.id}/settlements`)
      .set("Authorization", `Bearer ${cashier.access_token}`)
      .send({ clientOperationId: "settle-2a", branchId: fx.branchA1, amount: "5" });
    expect(forbidden.status).toBe(403);

    const settled = await request(app.getHttpServer())
      .post(`/v1/customers/${customer.body.id}/settlements`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "settle-2", branchId: fx.branchA1, amount: "5", notes: "cash payment" });
    expect(settled.status).toBe(201);
    expect(settled.body.balance).toBe("12.1000"); // 17.10 − 5

    // Replaying the same settlement op has zero side effects.
    const replay = await request(app.getHttpServer())
      .post(`/v1/customers/${customer.body.id}/settlements`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "settle-2", branchId: fx.branchA1, amount: "5" });
    expect(replay.status).toBe(201);
    expect(replay.body.replay).toBe(true);

    const after = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(after.body.balance).toBe("12.1000");
  });

  it("a refund of a credit sale reduces the receivable", async () => {
    const customer = await createCustomer(owner.access_token, { name: "Refund Co", creditLimit: "500" });
    const sale = await creditSale(owner.access_token, customer.body.id, "cust-sale-3");
    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${sale.body.id}/refund`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "cust-refund-3", amount: "17.10" });
    expect(refund.status).toBe(201);

    const detail = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(detail.body.balance).toBe("0.0000");
  });

  it("the statement lists every ledger entry with branch names", async () => {
    const customer = await createCustomer(owner.access_token, { name: "Statement Co", creditLimit: "500" });
    await creditSale(owner.access_token, customer.body.id, "cust-sale-4");
    await request(app.getHttpServer())
      .post(`/v1/customers/${customer.body.id}/settlements`)
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({ clientOperationId: "settle-4", branchId: fx.branchA1, amount: "2" });

    const stmt = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}/statement`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(stmt.status).toBe(200);
    expect(stmt.body.customer.id).toBe(customer.body.id);
    expect(stmt.body.entries).toHaveLength(2);
    expect(stmt.body.entries.map((e: { entryType: string }) => e.entryType).sort()).toEqual(["sale", "settlement"]);
    expect(stmt.body.entries[0].branchName).toBe("Main Branch");
  });

  it("settlements flush through the outbox (offline-first) and reconcile", async () => {
    const customer = await createCustomer(owner.access_token, { name: "Outbox Co", creditLimit: "500" });
    await creditSale(owner.access_token, customer.body.id, "cust-sale-5");

    const flush = await request(app.getHttpServer())
      .post("/v1/outbox")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({
        operations: [
          {
            id: "local-settle-1",
            type: "customer.settle",
            clientOperationId: "offline-settle-1",
            payload: { customerId: customer.body.id, branchId: fx.branchA1, amount: "7.10" },
          },
        ],
      });
    expect(flush.status).toBe(201);
    expect(flush.body.results[0].status).toBe("ok");

    const after = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(after.body.balance).toBe("10.0000"); // 17.10 − 7.10

    // Replaying the same offline batch has zero side effects.
    const replay = await request(app.getHttpServer())
      .post("/v1/outbox")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({
        operations: [
          {
            id: "local-settle-1",
            type: "customer.settle",
            clientOperationId: "offline-settle-1",
            payload: { customerId: customer.body.id, branchId: fx.branchA1, amount: "7.10" },
          },
        ],
      });
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].body.replay).toBe(true);

    const final = await request(app.getHttpServer())
      .get(`/v1/customers/${customer.body.id}`)
      .set("Authorization", `Bearer ${owner.access_token}`);
    expect(final.body.balance).toBe("10.0000");
  });

  it("RLS: org B can neither see nor settle org A's customers", async () => {
    const boss = await login(app, "boss@evilcorp.test");
    const list = await request(app.getHttpServer())
      .get("/v1/customers")
      .set("Authorization", `Bearer ${boss.access_token}`);
    expect(list.status).toBe(200);
    expect(list.body.customers).toEqual([]);

    const customers = await request(app.getHttpServer())
      .get("/v1/customers")
      .set("Authorization", `Bearer ${owner.access_token}`);
    const victim = customers.body.customers[0].id as string;
    const settle = await request(app.getHttpServer())
      .post(`/v1/customers/${victim}/settlements`)
      .set("Authorization", `Bearer ${boss.access_token}`)
      .send({ clientOperationId: "evil-settle", branchId: fx.branchB1, amount: "1" });
    expect(settle.status).toBe(404);
  });
});

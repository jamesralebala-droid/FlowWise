import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { DB_TOKEN } from "../src/db/constants.js";
import { RECEIPT_SENDER, type ReceiptSender } from "../src/receipts/receipts.service.js";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, type LoginResult } from "./helpers.js";

describe("eReceipts by email (Phase 5)", () => {
  let fx: Fixtures;
  let app: INestApplication; // default app: no provider configured
  let sentApp: INestApplication; // app with a stubbed sender
  let owner: LoginResult;

  const stub: ReceiptSender = {
    async send(opts) {
      sent.push(opts.to);
      return { id: "provider-msg-1" };
    },
  };
  let sent: string[];

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
    sent = [];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_TOKEN)
      .useValue(fx.db)
      .overrideProvider(RECEIPT_SENDER)
      .useValue(stub)
      .compile();
    sentApp = moduleRef.createNestApplication();
    sentApp.setGlobalPrefix("v1");
    await sentApp.init();

    owner = await login(app, "owner@flowwise.demo");
  });
  afterAll(async () => {
    await app.close();
    await sentApp.close();
    await fx.db.close();
  });

  const makeSale = async (clientOperationId: string) =>
    request(app.getHttpServer())
      .post("/v1/sales")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({
        clientOperationId,
        branchId: fx.branchA1,
        lines: [{ variantId: fx.variantA, quantity: "1" }],
        tenders: [{ tenderType: "cash", amount: "8.55" }],
      });

  const emailReceipt = (target: INestApplication, token: string, body: Record<string, unknown>) =>
    request(target.getHttpServer())
      .post("/v1/receipts/email")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("without a provider configured the attempt is recorded as skipped (never fails)", async () => {
    const sale = await makeSale("receipt-sale-1");
    expect(sale.status).toBe(201);

    const res = await emailReceipt(app, owner.access_token, {
      clientOperationId: "receipt-sale-1",
      to: "buyer@example.test",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("skipped");

    // Replay returns the stored attempt without re-recording.
    const replay = await emailReceipt(app, owner.access_token, {
      clientOperationId: "receipt-sale-1",
      to: "buyer@example.test",
    });
    expect(replay.status).toBe(201);
    expect(replay.body.replay).toBe(true);
  });

  it("with a provider the receipt is delivered and logged with the provider id", async () => {
    const sale = await makeSale("receipt-sale-2");
    expect(sale.status).toBe(201);

    const res = await emailReceipt(sentApp, owner.access_token, {
      clientOperationId: "receipt-sale-2",
      to: "buyer@example.test",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("sent");
    expect(res.body.providerMessageId).toBe("provider-msg-1");
    expect(sent).toContain("buyer@example.test");

    // A retry after a dropped response resolves to the same email (Invariant 4).
    const replay = await emailReceipt(sentApp, owner.access_token, {
      clientOperationId: "receipt-sale-2",
      to: "buyer@example.test",
    });
    expect(replay.status).toBe(201);
    expect(replay.body.replay).toBe(true);
    expect(sent.filter((t) => t === "buyer@example.test")).toHaveLength(1);
  });

  it("validates the recipient and requires a known completed sale", async () => {
    const badEmail = await emailReceipt(sentApp, owner.access_token, {
      clientOperationId: "receipt-sale-1",
      to: "not-an-email",
    });
    expect(badEmail.status).toBe(400);

    const unknown = await emailReceipt(sentApp, owner.access_token, {
      clientOperationId: "does-not-exist",
      to: "buyer@example.test",
    });
    expect(unknown.status).toBe(404);
  });

  it("the till can queue the receipt email through the outbox (offline-first)", async () => {
    const sale = await makeSale("receipt-sale-3");
    expect(sale.status).toBe(201);

    const flush = await request(sentApp.getHttpServer())
      .post("/v1/outbox")
      .set("Authorization", `Bearer ${owner.access_token}`)
      .send({
        operations: [
          {
            id: "local-receipt-1",
            type: "receipt.email",
            clientOperationId: "receipt-sale-3",
            payload: { clientOperationId: "receipt-sale-3", to: "offline@example.test" },
          },
        ],
      });
    expect(flush.status).toBe(201);
    expect(flush.body.results[0].status).toBe("ok");
    expect(flush.body.results[0].body.status).toBe("sent");
    expect(sent).toContain("offline@example.test");
  });
});

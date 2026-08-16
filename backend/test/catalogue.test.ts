import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login } from "./helpers.js";

describe("catalogue + permissions", () => {
  let fx: Fixtures;
  let app: INestApplication;

  beforeAll(async () => {
    fx = await createTestDb();
    app = await createTestApp(fx);
  });
  afterAll(async () => {
    await app.close();
    await fx.db.close();
  });

  it("a cashier pulls the branch catalogue and resolves a barcode with its price", async () => {
    const tokens = await login(app, "cashier@flowwise.demo");

    const cat = await request(app.getHttpServer())
      .get(`/v1/catalogue?branchId=${fx.branchA1}`)
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(cat.status).toBe(200);
    expect(cat.body.products).toHaveLength(2);
    expect(cat.body.variants).toHaveLength(2);
    expect(cat.body.barcodes).toHaveLength(1);
    expect(cat.body.prices).toHaveLength(2);

    const bc = await request(app.getHttpServer())
      .get("/v1/barcodes/6001234567890")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(bc.status).toBe(200);
    expect(bc.body.productName).toBe("Coca-Cola");
    expect(bc.body.variantName).toBe("330ml");
    expect(bc.body.price).toBe("7.5000");

    const missing = await request(app.getHttpServer())
      .get("/v1/barcodes/0000000000000")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(missing.status).toBe(404);
  });

  it("an org B token cannot see org A's catalogue (RLS through HTTP)", async () => {
    const tokens = await login(app, "boss@evilcorp.test");
    const cat = await request(app.getHttpServer())
      .get("/v1/catalogue")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(cat.status).toBe(200);
    expect(cat.body.products).toHaveLength(0);

    const me = await request(app.getHttpServer())
      .get("/v1/me")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.org.id).toBe(fx.orgB);
  });

  it("permissions are enforced server-side: a cashier cannot revoke the owner's device", async () => {
    const ownerTokens = await login(app, "owner@flowwise.demo");
    const reg = await request(app.getHttpServer())
      .post("/v1/devices/register")
      .set("Authorization", `Bearer ${ownerTokens.access_token}`)
      .send({ deviceName: "Owner Till" });
    expect(reg.status).toBe(201);
    const { deviceId } = reg.body as { deviceId: string };

    const cashierTokens = await login(app, "cashier@flowwise.demo");
    const attempt = await request(app.getHttpServer())
      .post(`/v1/devices/${deviceId}/revoke`)
      .set("Authorization", `Bearer ${cashierTokens.access_token}`);
    expect(attempt.status).toBe(403);

    const ownerOk = await request(app.getHttpServer())
      .post(`/v1/devices/${deviceId}/revoke`)
      .set("Authorization", `Bearer ${ownerTokens.access_token}`);
    expect(ownerOk.status).toBe(201);
  });

  it("unauthenticated requests are rejected", async () => {
    const me = await request(app.getHttpServer()).get("/v1/me");
    expect(me.status).toBe(401);
    const health = await request(app.getHttpServer()).get("/v1/healthz");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
  });
});

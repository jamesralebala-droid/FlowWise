import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { jwtVerify } from "jose";
import { createTestDb, type Fixtures } from "./setup.js";
import { createTestApp } from "./app.js";
import { login, pkce } from "./helpers.js";
import { env } from "../src/env.js";

const secret = new TextEncoder().encode(env.jwtSecret);

describe("OAuth2 PKCE + devices + /v1/me (Phase 0 exit)", () => {
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

  it("authorize → token exchange returns a 15-minute JWT with org + permission claims", async () => {
    const tokens = await login(app, "owner@flowwise.demo");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(900);

    const claims = (await jwtVerify(tokens.access_token, secret)).payload;
    expect(claims.sub).toBe(fx.ownerA);
    expect(claims.org).toBe(fx.orgA);
    expect(claims.perms).toContain("pos.sell");
    expect(claims.perms).toContain("audit.read");
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
  });

  it("GET /v1/me returns profile, org config, per-branch roles and branch scope", async () => {
    const tokens = await login(app, "cashier@flowwise.demo");
    const me = await request(app.getHttpServer())
      .get("/v1/me")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("cashier@flowwise.demo");
    expect(me.body.org.id).toBe(fx.orgA);
    expect(me.body.org.currency).toBe("BWP");
    expect(me.body.org.timezone).toBe("Africa/Gaborone");
    expect(me.body.org.vatRate).toBe("0.1400");
    expect(me.body.roles).toHaveLength(1);
    expect(me.body.roles[0].role).toBe("cashier");
    expect(me.body.roles[0].branchId).toBe(fx.branchA1);
    expect(me.body.defaultBranch).toBe(fx.branchA1);
    expect(me.body.branches).toHaveLength(2);
  });

  it("refresh tokens rotate, and replaying a used refresh token revokes the whole family", async () => {
    const tokens = await login(app, "owner@flowwise.demo");

    const rotated = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "refresh_token", refreshToken: tokens.refresh_token, clientId: "flowwise-app" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token);

    // Replaying the ORIGINAL (now rotated) token is a reuse signal.
    const replay = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "refresh_token", refreshToken: tokens.refresh_token, clientId: "flowwise-app" });
    expect(replay.status).toBe(401);

    // The whole family is now dead, including the freshly rotated one.
    const familyDead = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "refresh_token", refreshToken: rotated.body.refresh_token, clientId: "flowwise-app" });
    expect(familyDead.status).toBe(401);
  });

  it("authorization codes are single-use", async () => {
    const { verifier, challenge } = pkce();
    const auth = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "owner@flowwise.demo", password: "Password123!", clientId: "flowwise-app", codeChallenge: challenge });
    expect(auth.status).toBe(201);
    const { code } = auth.body as { code: string };

    const first = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "authorization_code", code, codeVerifier: verifier, clientId: "flowwise-app" });
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "authorization_code", code, codeVerifier: verifier, clientId: "flowwise-app" });
    expect(second.status).toBe(400);
  });

  it("PKCE verification failure is rejected", async () => {
    const { verifier, challenge } = pkce();
    const auth = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "owner@flowwise.demo", password: "Password123!", clientId: "flowwise-app", codeChallenge: challenge });
    const { code } = auth.body as { code: string };
    const bad = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "authorization_code", code, codeVerifier: `${verifier}x`, clientId: "flowwise-app" });
    expect(bad.status).toBe(400);
  });

  it("wrong password is rejected", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "owner@flowwise.demo", password: "wrong-password", clientId: "flowwise-app" });
    expect(res.status).toBe(401);
  });

  it("device registration returns a one-time device key; idempotent replay returns the same result", async () => {
    const tokens = await login(app, "owner@flowwise.demo");
    const register = (key: string) =>
      request(app.getHttpServer())
        .post("/v1/devices/register")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .set("Idempotency-Key", key)
        .send({ deviceName: "Till 1", platform: "android", appVersion: "0.1.0" });

    const first = await register("reg-key-1");
    expect(first.status).toBe(201);
    expect(first.body.deviceKey).toBeTruthy();

    const replay = await register("reg-key-1");
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);

    const count = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM devices WHERE org_id = $1", [fx.orgA]),
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("a revoked device immediately blocks its bound access token and refresh token", async () => {
    const tokens = await login(app, "owner@flowwise.demo");
    const reg = await request(app.getHttpServer())
      .post("/v1/devices/register")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ deviceName: "Till 2", platform: "android" });
    expect(reg.status).toBe(201);
    const { deviceId } = reg.body as { deviceId: string };

    // Bind the device into a fresh token via refresh rotation.
    const bound = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "refresh_token", refreshToken: tokens.refresh_token, clientId: "flowwise-app", deviceId });
    expect(bound.status).toBe(200);

    const meBefore = await request(app.getHttpServer())
      .get("/v1/me")
      .set("Authorization", `Bearer ${bound.body.access_token}`);
    expect(meBefore.status).toBe(200);

    const revoke = await request(app.getHttpServer())
      .post(`/v1/devices/${deviceId}/revoke`)
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(revoke.status).toBe(201);

    // The bound access token is now rejected immediately.
    const meAfter = await request(app.getHttpServer())
      .get("/v1/me")
      .set("Authorization", `Bearer ${bound.body.access_token}`);
    expect(meAfter.status).toBe(401);

    // The device-bound refresh token is dead too.
    const ref = await request(app.getHttpServer())
      .post("/v1/oauth/token")
      .send({ grantType: "refresh_token", refreshToken: bound.body.refresh_token, clientId: "flowwise-app" });
    expect(ref.status).toBe(401);
  });

  it("device actions write audit_log rows", async () => {
    const audit = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT action, entity_type FROM audit_log WHERE org_id = $1 ORDER BY id", [fx.orgA]),
    );
    const actions = audit.rows.map((r) => r.action as string);
    expect(actions).toContain("device.register");
    expect(actions).toContain("device.revoke");
  });

  // ---- Phase 4 hardening ---------------------------------------------------

  it("locks out an account+IP after repeated failed passwords (429), then recovers", async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post("/v1/oauth/authorize")
        .send({ username: "attacker@flowwise.demo", password: "nope", clientId: "flowwise-app" });

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }

    // The 6th attempt within the window is throttled — and it must be 429
    // BEFORE any credential work, so the throttle leaks nothing about the
    // account's existence.
    const locked = await attempt();
    expect(locked.status).toBe(429);

    // Other accounts from the same IP are unaffected.
    const other = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "owner@flowwise.demo", password: "Password123!", clientId: "flowwise-app" });
    expect(other.status).toBe(201);

    // Clearing the failures (as time passing would) lets the account in again.
    await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("DELETE FROM auth_attempts WHERE username = 'attacker@flowwise.demo'"),
    );
    const recovered = await attempt();
    expect(recovered.status).toBe(401); // wrong password again, but no longer throttled
  });

  it("a successful login clears the failure streak for that account+IP", async () => {
    const wrong = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "cashier@flowwise.demo", password: "wrong", clientId: "flowwise-app" });
    expect(wrong.status).toBe(401);

    const right = await request(app.getHttpServer())
      .post("/v1/oauth/authorize")
      .send({ username: "cashier@flowwise.demo", password: "Password123!", clientId: "flowwise-app" });
    expect(right.status).toBe(201);

    const attempts = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM auth_attempts WHERE username = 'cashier@flowwise.demo'"),
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  it("GET /v1/audit exposes the trail to auditors only", async () => {
    const auditor = await login(app, "auditor@flowwise.demo");
    const res = await request(app.getHttpServer())
      .get("/v1/audit?action=device.register")
      .set("Authorization", `Bearer ${auditor.access_token}`);
    expect(res.status).toBe(200);
    const events = res.body.events as { action: string; entityType: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.action === "device.register" && e.entityType === "device")).toBe(true);

    // A cashier has no audit.read permission.
    const cashier = await login(app, "cashier@flowwise.demo");
    const forbidden = await request(app.getHttpServer())
      .get("/v1/audit")
      .set("Authorization", `Bearer ${cashier.access_token}`);
    expect(forbidden.status).toBe(403);
  });
});

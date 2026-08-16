import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDb, type Fixtures } from "./setup.js";

describe("RLS multi-tenancy (Migration 001)", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await createTestDb();
  });
  afterAll(async () => {
    await fx.db.close();
  });

  it("org A sees exactly its own branches", async () => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) => tx.query("SELECT id FROM branches"));
    expect(r.rows.length).toBe(2);
  });

  it("org A cannot read org B branches, even by direct id", async () => {
    const r = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT id FROM branches WHERE org_id = $1", [fx.orgB]),
    );
    expect(r.rows.length).toBe(0);
  });

  it("org A cannot INSERT a branch into org B (WITH CHECK rejects)", async () => {
    let threw = false;
    try {
      await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
        tx.query("INSERT INTO branches (org_id, name, code) VALUES ($1, 'Sneak', 'X1')", [fx.orgB]),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("org B sees only its own users", async () => {
    const r = await fx.db.withContext({ orgId: fx.orgB, userId: fx.ownerB }, (tx) => tx.query("SELECT id FROM users"));
    expect(r.rows.length).toBe(1);
  });

  it("no tenant context → fail closed (zero rows)", async () => {
    const all = await fx.db.withSystem((tx) => tx.query("SELECT count(*)::int AS n FROM users"));
    expect(all.rows[0].n).toBe(0);
  });

  it("the five system roles and the permission catalogue are seeded", async () => {
    const roles = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) => tx.query("SELECT count(*)::int AS n FROM roles"));
    expect(roles.rows[0].n).toBe(5);
    const perms = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) => tx.query("SELECT count(*)::int AS n FROM permissions"));
    expect(perms.rows[0].n).toBeGreaterThanOrEqual(22);
    // Phase 5: cashier + customer.read/customer.write (till), auditor + customer.read.
    const cashier = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM role_permissions WHERE role_code = 'cashier'"),
    );
    expect(cashier.rows[0].n).toBe(7);
    const auditor = await fx.db.withContext({ orgId: fx.orgA, userId: fx.ownerA }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM role_permissions WHERE role_code = 'auditor'"),
    );
    expect(auditor.rows[0].n).toBe(6);
  });

  it("the security-definer auth lookup still works without tenant context", async () => {
    const r = await fx.db.withSystem((tx) => tx.query("SELECT * FROM auth_lookup_user_by_email($1)", ["owner@flowwise.demo"]));
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].org_id).toBe(fx.orgA);
  });
});

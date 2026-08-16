import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export interface CustomerInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  creditLimit?: string;
  isActive?: boolean;
}

export interface SettleInput {
  clientOperationId: string;
  customerId: string;
  branchId: string;
  /** decimal STRING — the amount the customer pays (always positive) */
  amount: string;
  notes?: string;
}

function assertDecimal(value: string, name: string, allowZero = false): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new BadRequestException(`${name} must be a decimal string (up to 4 dp)`);
  }
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || (!allowZero && n === 0)) {
    throw new BadRequestException(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return value;
}

function cleanCustomerInput(input: CustomerInput): CustomerInput {
  const out: CustomerInput = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new BadRequestException("name is required");
    out.name = name;
  }
  if (input.phone !== undefined) out.phone = String(input.phone).trim() || null;
  if (input.email !== undefined) {
    const email = String(input.email).trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("email must be a valid address");
    }
    out.email = email || null;
  }
  // Zero is a valid credit limit — it means "no credit" (enforced at sale time).
  if (input.creditLimit !== undefined) out.creditLimit = assertDecimal(String(input.creditLimit), "creditLimit", true);
  if (input.isActive !== undefined) out.isActive = Boolean(input.isActive);
  return out;
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(claims: JwtPayloadClaims, opts: { q?: string } = {}): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const params: unknown[] = [claims.org];
        let where = "c.org_id = $1";
        if (opts.q) {
          params.push(`%${opts.q.toLowerCase()}%`);
          where += ` AND (lower(c.name) LIKE $${params.length} OR lower(COALESCE(c.phone, '')) LIKE $${params.length} OR lower(COALESCE(c.email, '')) LIKE $${params.length})`;
        }
        const r = await tx.query(
          `SELECT c.id, c.name, c.phone, c.email, c.credit_limit AS "creditLimit",
                  c.is_active AS "isActive", c.created_at AS "createdAt",
                  COALESCE(b.balance, 0)::numeric(14,4) AS balance,
                  COALESCE(l.points, 0)::int AS "loyaltyPoints"
           FROM customers c
           LEFT JOIN v_customer_balances b ON b.customer_id = c.id AND b.org_id = c.org_id
           LEFT JOIN v_customer_loyalty l ON l.customer_id = c.id AND l.org_id = c.org_id
           WHERE ${where}
           ORDER BY c.name
           LIMIT 200`,
          params,
        );
        return { customers: r.rows };
      },
    );
  }

  async get(claims: JwtPayloadClaims, customerId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const c = await tx.query(
          `SELECT c.id, c.name, c.phone, c.email, c.credit_limit AS "creditLimit",
                  c.is_active AS "isActive", c.created_at AS "createdAt",
                  COALESCE(b.balance, 0)::numeric(14,4) AS balance,
                  COALESCE(l.points, 0)::int AS "loyaltyPoints"
           FROM customers c
           LEFT JOIN v_customer_balances b ON b.customer_id = c.id AND b.org_id = c.org_id
           LEFT JOIN v_customer_loyalty l ON l.customer_id = c.id AND l.org_id = c.org_id
           WHERE c.id = $1 AND c.org_id = $2`,
          [customerId, claims.org],
        );
        if (c.rows.length === 0) throw new NotFoundException("Customer not found");
        return c.rows[0];
      },
    );
  }

  async create(claims: JwtPayloadClaims, input: CustomerInput): Promise<unknown> {
    const cleaned = cleanCustomerInput(input);
    if (!cleaned.name) throw new BadRequestException("name is required");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        // Email uniqueness is enforced by a partial unique index; surface a
        // friendly error instead of a raw constraint violation.
        if (cleaned.email) {
          const dup = await tx.query(
            "SELECT id FROM customers WHERE org_id = $1 AND lower(trim(email)) = $2",
            [claims.org, cleaned.email],
          );
          if (dup.rows.length > 0) throw new BadRequestException("A customer with this email already exists");
        }
        const r = await tx.query(
          `INSERT INTO customers (org_id, name, phone, email, credit_limit)
           VALUES ($1, $2, $3, $4, $5::numeric(14,4))
           RETURNING id, name, phone, email, credit_limit AS "creditLimit", is_active AS "isActive", created_at AS "createdAt"`,
          [claims.org, cleaned.name, cleaned.phone ?? null, cleaned.email ?? null, cleaned.creditLimit ?? "0"],
        );
        const id = r.rows[0].id as string;
        await this.audit.write(tx, "customer.create", "customer", id, null, JSON.stringify(cleaned));
        return { ...r.rows[0], balance: "0.0000" };
      },
    );
  }

  async update(claims: JwtPayloadClaims, customerId: string, input: CustomerInput): Promise<unknown> {
    const cleaned = cleanCustomerInput(input);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, name FROM customers WHERE id = $1 AND org_id = $2", [
          customerId,
          claims.org,
        ]);
        if (existing.rows.length === 0) throw new NotFoundException("Customer not found");
        if (cleaned.email) {
          const dup = await tx.query(
            "SELECT id FROM customers WHERE org_id = $1 AND lower(trim(email)) = $2 AND id <> $3",
            [claims.org, cleaned.email, customerId],
          );
          if (dup.rows.length > 0) throw new BadRequestException("A customer with this email already exists");
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        const push = (col: string, v: unknown) => {
          params.push(v);
          sets.push(`${col} = $${params.length}`);
        };
        if (cleaned.name !== undefined) push("name", cleaned.name);
        if (cleaned.phone !== undefined) push("phone", cleaned.phone);
        if (cleaned.email !== undefined) push("email", cleaned.email);
        if (cleaned.creditLimit !== undefined) push("credit_limit", cleaned.creditLimit);
        if (cleaned.isActive !== undefined) push("is_active", cleaned.isActive);
        if (sets.length === 0) throw new BadRequestException("Nothing to update");
        params.push(customerId, claims.org);
        const r = await tx.query(
          `UPDATE customers SET ${sets.join(", ")}, updated_at = now()
           WHERE id = $${params.length - 1} AND org_id = $${params.length}
           RETURNING id, name, phone, email, credit_limit AS "creditLimit", is_active AS "isActive", updated_at AS "updatedAt"`,
          params,
        );
        await this.audit.write(tx, "customer.update", "customer", customerId, null, JSON.stringify(cleaned));
        return r.rows[0];
      },
    );
  }

  /** Full statement: opening-ish cursor + every ledger entry + live balance. */
  async statement(
    claims: JwtPayloadClaims,
    customerId: string,
    opts: { from?: string; to?: string } = {},
  ): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        // Inline the customer lookup on tx — this.get() opens its own
        // transaction, which deadlocks inside an active PGlite transaction.
        const customer = await tx.query(
          `SELECT c.id, c.name, c.phone, c.email, c.credit_limit AS "creditLimit",
                  c.is_active AS "isActive", c.created_at AS "createdAt",
                  COALESCE(b.balance, 0)::numeric(14,4) AS balance,
                  COALESCE(l.points, 0)::int AS "loyaltyPoints"
           FROM customers c
           LEFT JOIN v_customer_balances b ON b.customer_id = c.id AND b.org_id = c.org_id
           LEFT JOIN v_customer_loyalty l ON l.customer_id = c.id AND l.org_id = c.org_id
           WHERE c.id = $1 AND c.org_id = $2`,
          [customerId, claims.org],
        );
        if (customer.rows.length === 0) throw new NotFoundException("Customer not found");
        const params: unknown[] = [claims.org, customerId];
        const clauses = ["cl.org_id = $1", "cl.customer_id = $2"];
        if (opts.from) {
          params.push(new Date(opts.from).toISOString());
          clauses.push(`cl.business_time >= $${params.length}`);
        }
        if (opts.to) {
          params.push(new Date(opts.to).toISOString());
          clauses.push(`cl.business_time <= $${params.length}`);
        }
        const r = await tx.query(
          `SELECT cl.id, cl.branch_id AS "branchId", b.name AS "branchName",
                  cl.entry_type AS "entryType", cl.amount, cl.reference_type AS "referenceType",
                  cl.reference_id AS "referenceId", cl.notes, cl.business_time AS "businessTime",
                  cl.created_by_user_id AS "createdByUserId", cl.client_operation_id AS "clientOperationId"
           FROM customer_ledger cl
           LEFT JOIN branches b ON b.id = cl.branch_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY cl.business_time DESC, cl.id DESC
           LIMIT 500`,
          params,
        );
        return { customer: customer.rows[0], entries: r.rows };
      },
    );
  }

  /**
   * Records a payment against the customer's account. The receivable ledger
   * row is negative (debt decreases); replay-safe on client_operation_id
   * (Invariant 4). Settlements are online-first in Phase 5 — the till queues
   * them through the outbox when it flushes, same as every other write.
   */
  async settle(claims: JwtPayloadClaims, input: SettleInput): Promise<unknown> {
    const opId = input.clientOperationId?.trim();
    if (!opId) throw new BadRequestException("clientOperationId is required");
    const amount = assertDecimal(input.amount, "amount");
    if (!input.customerId) throw new BadRequestException("customerId is required");
    if (!input.branchId) throw new BadRequestException("branchId is required");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query(
          `SELECT id, amount, business_time AS "businessTime"
           FROM customer_ledger
           WHERE org_id = $1 AND customer_id = $2 AND client_operation_id = $3`,
          [claims.org, input.customerId, opId],
        );
        if (existing.rows.length > 0) {
          return { id: existing.rows[0].id, amount: existing.rows[0].amount, replay: true };
        }

        const customer = await tx.query(
          "SELECT id, name FROM customers WHERE id = $1 AND org_id = $2 AND is_active",
          [input.customerId, claims.org],
        );
        if (customer.rows.length === 0) throw new NotFoundException("Customer not found");

        const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [
          input.branchId,
          claims.org,
        ]);
        if (branch.rows.length === 0) throw new BadRequestException("Unknown branch");

        const r = await tx.query(
          `INSERT INTO customer_ledger
             (org_id, customer_id, branch_id, entry_type, amount, reference_type, notes,
              client_operation_id, business_time, created_by_user_id, created_by_device_id)
           VALUES ($1, $2, $3, 'settlement', -$4::numeric(14,4), 'settlement', $5, $6, now(), $7, $8)
           RETURNING id, amount, business_time AS "businessTime"`,
          [
            claims.org,
            input.customerId,
            input.branchId,
            amount,
            input.notes ?? null,
            opId,
            claims.sub,
            claims.dev ?? null,
          ],
        );

        await this.audit.write(tx, "customer.settle", "customer", input.customerId, null, JSON.stringify({ amount }));

        const balance = await tx.query(
          "SELECT COALESCE(SUM(amount), 0)::numeric(14,4) AS balance FROM customer_ledger WHERE org_id = $1 AND customer_id = $2",
          [claims.org, input.customerId],
        );
        return { ...r.rows[0], customerId: input.customerId, balance: balance.rows[0].balance };
      },
    );
  }
}

import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import { env } from "../env.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

export const MOBILE_MONEY_PROVIDER = Symbol("flowwise:mobile-money-provider");

export interface MobileMoneyInitiateOpts {
  amount: string;
  currency: string;
  phone: string;
  /** the sale's client_operation_id — echoed to the provider for reconciliation */
  merchantReference: string;
}

export interface MobileMoneyInitiateResult {
  status: "pending" | "confirmed";
  providerReference?: string;
  providerStatus?: string;
}

export interface MobileMoneyRefundOpts {
  amount: string;
  currency: string;
  phone: string;
  /** original payment's provider reference, when the provider gave us one */
  providerReference?: string;
  /** the refund's client_operation_id — echoed for reconciliation */
  merchantReference: string;
}

export interface MobileMoneyRefundResult {
  status: "pending" | "confirmed";
  providerReference?: string;
  providerStatus?: string;
}

/** Injectable so tests can stub the provider (no network). */
export interface MobileMoneyProvider {
  name: string;
  initiate(opts: MobileMoneyInitiateOpts): Promise<MobileMoneyInitiateResult>;
  /** Phase 7: push a refund back to the customer's wallet. */
  refund(opts: MobileMoneyRefundOpts): Promise<MobileMoneyRefundResult>;
}

/**
 * Default provider: confirms instantly, no network, no credentials. This is
 * the sandbox/demo path AND the degraded path when a real provider is not
 * configured — the till keeps selling (offline-first), payments reconcile
 * as confirmed against the local ledger.
 */
export class MockMobileMoneyProvider implements MobileMoneyProvider {
  readonly name = "mock";
  async initiate(opts: MobileMoneyInitiateOpts): Promise<MobileMoneyInitiateResult> {
    return {
      status: "confirmed",
      providerReference: `mock-${opts.merchantReference.slice(0, 24)}`,
      providerStatus: "completed",
    };
  }

  async refund(opts: MobileMoneyRefundOpts): Promise<MobileMoneyRefundResult> {
    return {
      status: "confirmed",
      providerReference: `mock-refund-${opts.merchantReference.slice(0, 24)}`,
      providerStatus: "completed",
    };
  }
}

/**
 * Dodo Payments provider (Phase 6). Server-to-server initiate via the Dodo
 * REST API; confirmation arrives asynchronously through
 * POST /v1/mobile-money/webhook (HMAC-verified) or a later status pull.
 *
 * The exact payload shape should be checked against the Dodo SDK docs when
 * credentials are provisioned — this adapter implements the documented
 * initiate contract and is isolated behind the provider interface, so any
 * drift only affects the Dodo path, never the till or the ledger.
 */
export class DodoMobileMoneyProvider implements MobileMoneyProvider {
  readonly name = "dodo";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.dodopayments.com",
  ) {}

  async initiate(opts: MobileMoneyInitiateOpts): Promise<MobileMoneyInitiateResult> {
    const res = await fetch(`${this.baseUrl}/v1/payments/initiate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment_method: "mobile_money",
        amount: Number(opts.amount).toFixed(2),
        currency: opts.currency,
        customer: { phone: opts.phone },
        merchant_reference: opts.merchantReference,
      }),
    });
    if (!res.ok) {
      throw new Error(`Dodo initiate failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      status: String(data.status ?? "pending") === "completed" ? "confirmed" : "pending",
      providerReference: typeof data.payment_id === "string" ? data.payment_id : undefined,
      providerStatus: typeof data.status === "string" ? data.status : undefined,
    };
  }

  /**
   * Phase 7: reverse a completed payment back to the customer's wallet. The
   * exact Dodo refund contract should be confirmed against the SDK docs when
   * credentials are provisioned — the adapter is isolated behind the provider
   * interface, so drift only affects the Dodo path.
   */
  async refund(opts: MobileMoneyRefundOpts): Promise<MobileMoneyRefundResult> {
    const res = await fetch(`${this.baseUrl}/v1/payments/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment_reference: opts.providerReference,
        amount: Number(opts.amount).toFixed(2),
        currency: opts.currency,
        merchant_reference: opts.merchantReference,
      }),
    });
    if (!res.ok) {
      throw new Error(`Dodo refund failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      status: String(data.status ?? "pending") === "completed" ? "confirmed" : "pending",
      providerReference: typeof data.refund_id === "string" ? data.refund_id : undefined,
      providerStatus: typeof data.status === "string" ? data.status : undefined,
    };
  }
}

export interface MobileMoneyWebhookBody {
  event?: string;
  payment?: { reference?: string; status?: string };
  /** Phase 7: refund/payout confirmation events carry this object. */
  payout?: { reference?: string; status?: string };
}

@Injectable()
export class MobileMoneyService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(MOBILE_MONEY_PROVIDER) private readonly provider: MobileMoneyProvider,
    private readonly audit: AuditService,
  ) {}

  /**
   * Called AFTER the sale transaction commits (never inside it — the provider
   * is a network call). The payment row was created in the sale transaction;
   * this drives it through the configured provider. A provider failure marks
   * the row 'failed' but never rethrows: the till already has its sale.
   */
  async initiateForSale(claims: JwtPayloadClaims, saleId: string, phone: string, amount: string): Promise<void> {
    try {
      const result = await this.provider.initiate({
        amount,
        currency: "BWP",
        phone,
        merchantReference: `sale:${saleId}`,
      });
      await this.db.withContext(
        { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
        async (tx) => {
          const row = await tx.query("SELECT id FROM mobile_money_payments WHERE org_id = $1 AND sale_id = $2", [
            claims.org,
            saleId,
          ]);
          if (row.rows.length === 0) return;
          const paymentId = row.rows[0].id as string;
          const now = result.status === "confirmed" ? new Date().toISOString() : null;
          await tx.query(
            `UPDATE mobile_money_payments
             SET status = $3, provider_reference = COALESCE($4, provider_reference),
                 provider_status = COALESCE($5, provider_status), error = NULL,
                 confirmed_at = COALESCE($6::timestamptz, confirmed_at), updated_at = now()
             WHERE id = $1 AND org_id = $2`,
            [paymentId, claims.org, result.status, result.providerReference ?? null, result.providerStatus ?? null, now],
          );
          await this.audit.write(tx, "mobile_money.initiate", "sale", saleId, null, JSON.stringify(result));
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "provider error";
      try {
        await this.db.withContext(
          { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
          async (tx) => {
            await tx.query(
              `UPDATE mobile_money_payments
               SET status = 'failed', error = $3, updated_at = now()
               WHERE org_id = $1 AND sale_id = $2`,
              [claims.org, saleId, message],
            );
            await this.audit.write(tx, "mobile_money.failed", "sale", saleId, null, JSON.stringify({ error: message }));
          },
        );
      } catch {
        /* the sale is committed and immutable; the payment row is best-effort */
      }
    }
  }

  /**
   * Phase 7: drive a payout (refund-to-wallet) through the provider AFTER
   * the refund transaction commits. The payout row was created in the refund
   * transaction; this only updates rows still pending. A provider failure
   * marks the payout 'failed' but never rethrows — the refund already
   * happened on the ledger and the till.
   */
  async refundForSale(
    claims: JwtPayloadClaims,
    refundId: string,
    saleId: string,
    phone: string,
    amount: string,
    providerReference: string | null,
  ): Promise<void> {
    try {
      const result = await this.provider.refund({
        amount,
        currency: "BWP",
        phone,
        providerReference: providerReference ?? undefined,
        merchantReference: `refund:${refundId}`,
      });
      await this.db.withContext(
        { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
        async (tx) => {
          const row = await tx.query("SELECT id FROM mobile_money_payouts WHERE org_id = $1 AND refund_id = $2", [
            claims.org,
            refundId,
          ]);
          if (row.rows.length === 0) return;
          const payoutId = row.rows[0].id as string;
          const now = result.status === "confirmed" ? new Date().toISOString() : null;
          await tx.query(
            `UPDATE mobile_money_payouts
             SET status = $3, provider_reference = COALESCE($4, provider_reference),
                 provider_status = COALESCE($5, provider_status), error = NULL,
                 confirmed_at = COALESCE($6::timestamptz, confirmed_at), updated_at = now()
             WHERE id = $1 AND org_id = $2`,
            [payoutId, claims.org, result.status, result.providerReference ?? null, result.providerStatus ?? null, now],
          );
          await this.audit.write(tx, "mobile_money.refund", "sale", saleId, null, JSON.stringify({ refundId, ...result }));
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "provider error";
      try {
        await this.db.withContext(
          { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
          async (tx) => {
            await tx.query(
              `UPDATE mobile_money_payouts
               SET status = 'failed', error = $3, updated_at = now()
               WHERE org_id = $1 AND refund_id = $2`,
              [claims.org, refundId, message],
            );
            await this.audit.write(tx, "mobile_money.refund_failed", "sale", saleId, null, JSON.stringify({ refundId, error: message }));
          },
        );
      } catch {
        /* the refund is committed and immutable; the payout row is best-effort */
      }
    }
  }

  /** Till/back-office pull of payment statuses (half of the async reconcile). */
  async list(
    claims: JwtPayloadClaims,
    opts: { branchId?: string; status?: string; since?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1"];
        const params: unknown[] = [claims.org];
        if (opts.branchId) {
          params.push(opts.branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        if (opts.status) {
          if (!["pending", "confirmed", "failed"].includes(opts.status)) {
            throw new BadRequestException("status must be pending, confirmed or failed");
          }
          params.push(opts.status);
          clauses.push(`status = $${params.length}`);
        }
        if (opts.since) {
          params.push(opts.since);
          clauses.push(`created_at > $${params.length}`);
        }
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
        params.push(limit);
        const r = await tx.query(
          `SELECT id, branch_id AS "branchId", sale_id AS "saleId", provider, phone, amount, status,
                  provider_reference AS "providerReference", provider_status AS "providerStatus",
                  error, confirmed_at AS "confirmedAt", created_at AS "createdAt"
           FROM mobile_money_payments
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        );
        return { payments: r.rows };
      },
    );
  }

  /** Phase 7: back-office pull of payout (refund) statuses. */
  async listPayouts(
    claims: JwtPayloadClaims,
    opts: { branchId?: string; status?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1"];
        const params: unknown[] = [claims.org];
        if (opts.branchId) {
          params.push(opts.branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        if (opts.status) {
          if (!["pending", "confirmed", "failed"].includes(opts.status)) {
            throw new BadRequestException("status must be pending, confirmed or failed");
          }
          params.push(opts.status);
          clauses.push(`status = $${params.length}`);
        }
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
        params.push(limit);
        const r = await tx.query(
          `SELECT id, branch_id AS "branchId", sale_id AS "saleId", refund_id AS "refundId",
                  provider, phone, amount, status,
                  provider_reference AS "providerReference", provider_status AS "providerStatus",
                  error, confirmed_at AS "confirmedAt", created_at AS "createdAt"
           FROM mobile_money_payouts
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        );
        return { payouts: r.rows };
      },
    );
  }

  /**
   * Provider webhook: confirms/fails a PAYMENT or a PAYOUT (Phase 7) by
   * provider reference. Verifies HMAC-SHA256 over the raw body with
   * DODO_WEBHOOK_SECRET. Without a configured secret the endpoint refuses
   * everything (never trust an unverified gateway callback).
   */
  async handleWebhook(
    rawBody: Buffer | null,
    signature: string | undefined,
    body: MobileMoneyWebhookBody,
  ): Promise<{ ok: boolean }> {
    const secret = env.dodoWebhookSecret;
    if (!secret) throw new UnauthorizedException("mobile-money webhook not configured");
    if (!rawBody) throw new UnauthorizedException("missing body");

    const sig = (signature ?? "").toLowerCase();
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
      throw new UnauthorizedException("invalid webhook signature");
    }

    if (body.payout) {
      return this.confirmPayout(reference(body.payout), status(body.payout));
    }
    if (body.payment) {
      return this.confirmPayment(reference(body.payment), status(body.payment));
    }
    throw new BadRequestException("payment or payout object with reference + status is required");
  }

  private async confirmPayment(reference: string, status: string): Promise<{ ok: boolean }> {
    if (status !== "completed" && status !== "failed") {
      throw new BadRequestException("payment.status must be completed or failed");
    }
    // SECURITY DEFINER: resolves the row by provider reference across orgs
    // (gateway callbacks carry no tenant session).
    const row = await this.db.withSystem((tx) =>
      tx.query("SELECT id, org_id AS \"orgId\", sale_id AS \"saleId\" FROM confirm_mobile_money_payment($1, $2)", [
        reference,
        status,
      ]),
    );
    if (row.rows.length === 0) throw new NotFoundException("Unknown provider reference");
    const resolved = row.rows[0] as { id: string; orgId: string; saleId: string };
    await this.auditInOrg(
      resolved.orgId,
      status === "completed" ? "mobile_money.confirmed" : "mobile_money.failed",
      resolved.saleId,
      JSON.stringify({ providerReference: reference, status, paymentId: resolved.id }),
    );
    return { ok: true };
  }

  private async confirmPayout(reference: string, status: string): Promise<{ ok: boolean }> {
    if (status !== "completed" && status !== "failed") {
      throw new BadRequestException("payout.status must be completed or failed");
    }
    const row = await this.db.withSystem((tx) =>
      tx.query("SELECT id, org_id AS \"orgId\", sale_id AS \"saleId\", refund_id AS \"refundId\" FROM confirm_mobile_money_payout($1, $2)", [
        reference,
        status,
      ]),
    );
    if (row.rows.length === 0) throw new NotFoundException("Unknown provider reference");
    const resolved = row.rows[0] as { id: string; orgId: string; saleId: string; refundId: string };
    await this.auditInOrg(
      resolved.orgId,
      status === "completed" ? "mobile_money.payout_confirmed" : "mobile_money.payout_failed",
      resolved.saleId,
      JSON.stringify({ providerReference: reference, status, payoutId: resolved.id, refundId: resolved.refundId }),
    );
    return { ok: true };
  }

  private async auditInOrg(orgId: string, action: string, saleId: string, detail: string): Promise<void> {
    await this.db.withContext(
      { orgId, userId: null, deviceId: null },
      (tx) => this.audit.write(tx, action, "sale", saleId, null, detail),
    );
  }
}

function reference(o: { reference?: string }): string {
  const r = o.reference;
  if (!r) throw new BadRequestException("reference is required");
  return r;
}

function status(o: { status?: string }): string {
  const s = o.status;
  if (!s) throw new BadRequestException("status is required");
  return s;
}

/** Insert the pending payment row INSIDE the sale transaction (Invariant 3). */
export async function createMobileMoneyPayment(
  tx: DbExecutor,
  orgId: string,
  branchId: string,
  saleId: string,
  provider: string,
  phone: string,
  amount: string,
  clientOperationId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO mobile_money_payments
       (org_id, branch_id, sale_id, provider, phone, amount, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6::numeric(14,4), 'pending', $7)
     ON CONFLICT (org_id, sale_id) DO NOTHING`,
    [orgId, branchId, saleId, provider, phone, amount, `sale:${clientOperationId}:mobile`],
  );
}

/** Insert the pending payout row INSIDE the refund transaction (Invariant 3). */
export async function createMobileMoneyPayout(
  tx: DbExecutor,
  orgId: string,
  branchId: string,
  paymentId: string,
  saleId: string,
  refundId: string,
  provider: string,
  phone: string,
  amount: string,
  clientOperationId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO mobile_money_payouts
       (org_id, branch_id, payment_id, sale_id, refund_id, provider, phone, amount, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric(14,4), 'pending', $9)
     ON CONFLICT (org_id, refund_id) DO NOTHING`,
    [orgId, branchId, paymentId, saleId, refundId, provider, phone, amount, `refund:${clientOperationId}:payout`],
  );
}

export { env };

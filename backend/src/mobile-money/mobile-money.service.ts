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

/** Injectable so tests can stub the provider (no network). */
export interface MobileMoneyProvider {
  name: string;
  initiate(opts: MobileMoneyInitiateOpts): Promise<MobileMoneyInitiateResult>;
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
}

export interface MobileMoneyWebhookBody {
  event?: string;
  payment?: { reference?: string; status?: string };
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

  /**
   * Provider webhook: confirms/fails a payment by provider reference.
   * Verifies HMAC-SHA256 over the raw body with DODO_WEBHOOK_SECRET. Without
   * a configured secret the endpoint refuses everything (never trust an
   * unverified gateway callback).
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

    const payment = body.payment;
    const reference = payment?.reference;
    const status = payment?.status;
    if (!reference || !status) throw new BadRequestException("payment.reference and payment.status are required");
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

    // Audit inside the resolved org's tenant context (fn_write_audit reads
    // the session GUCs; there is no signed-in user for a gateway callback).
    await this.db.withContext(
      { orgId: resolved.orgId, userId: null, deviceId: null },
      (tx) =>
        this.audit.write(
          tx,
          status === "completed" ? "mobile_money.confirmed" : "mobile_money.failed",
          "sale",
          resolved.saleId,
          null,
          JSON.stringify({ providerReference: reference, status, paymentId: resolved.id }),
        ),
    );
    return { ok: true };
  }
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

export { env };

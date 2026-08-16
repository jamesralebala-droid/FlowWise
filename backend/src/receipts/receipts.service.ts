import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import { env } from "../env.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

export const RECEIPT_SENDER = Symbol("flowwise:receipt-sender");

export interface ReceiptEmailOpts {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Injectable so tests can stub the provider (no network). */
export interface ReceiptSender {
  send(opts: ReceiptEmailOpts): Promise<{ id: string }>;
}

/**
 * Production sender backed by Resend. The SDK is loaded LAZILY on the first
 * actual send: the module is heavy, and test processes / key-less installs
 * should never pay to load it (sandbox memory is tight).
 */
export class ResendSender implements ReceiptSender {
  private client: {
    emails: { send(o: unknown): Promise<{ error: unknown; data?: { id?: string } | null }> };
  } | null = null;

  constructor(private readonly apiKey: string | undefined) {}

  async send(opts: ReceiptEmailOpts): Promise<{ id: string }> {
    if (!this.apiKey) throw new Error("Resend API key not configured");
    let client = this.client;
    if (!client) {
      const { Resend } = await import("resend");
      client = new Resend(this.apiKey);
      this.client = client;
    }
    const { error, data } = await client.emails.send({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    if (error) throw new Error(error instanceof Error ? error.message : String(error));
    return { id: data?.id ?? "" };
  }
}

export interface ReceiptEmailInput {
  /** The SALE's client operation id — the receipt is found by it because the
   *  till may still be offline when the sale is rung (the email op flushes in
   *  the same batch, after the sale op, in createdAt order). */
  clientOperationId: string;
  to: string;
}

@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(RECEIPT_SENDER) private readonly sender: ReceiptSender | null,
    private readonly audit: AuditService,
  ) {}

  /**
   * Emails a receipt for a completed sale. Replay-safe: one email per
   * (org, sale, recipient) — a retried upload returns the stored attempt.
   * Without a Resend key the attempt is recorded as 'skipped' (the till keeps
   * selling; nothing breaks offline-first).
   */
  async sendReceipt(claims: JwtPayloadClaims, input: ReceiptEmailInput): Promise<unknown> {
    const opId = input.clientOperationId?.trim();
    const to = String(input.to ?? "").trim().toLowerCase();
    if (!opId) throw new BadRequestException("clientOperationId is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new BadRequestException("to must be a valid email address");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const sale = await tx.query(
          `SELECT s.id, s.total, s.business_time AS "businessTime", s.client_operation_id AS "clientOperationId",
                  b.name AS "branchName", o.name AS "orgName", o.currency_code AS "currency"
           FROM sales s
           JOIN branches b ON b.id = s.branch_id
           JOIN organisations o ON o.id = s.org_id
           WHERE s.org_id = $1 AND s.client_operation_id = $2 AND s.status = 'completed'`,
          [claims.org, opId],
        );
        if (sale.rows.length === 0) throw new NotFoundException("Completed sale not found");

        const saleId = sale.rows[0].id as string;

        // Replay: already sent or skipped → return the stored attempt.
        const existing = await tx.query(
          "SELECT status, provider_message_id AS \"providerMessageId\", attempted_at AS \"attemptedAt\" FROM receipt_emails WHERE org_id = $1 AND sale_id = $2 AND to_email = $3",
          [claims.org, saleId, to],
        );
        const existingRow = existing.rows[0];
        if (existingRow && (existingRow.status === "sent" || existingRow.status === "skipped")) {
          return { saleId, to, ...existingRow, replay: true };
        }

        const lines = await tx.query(
          `SELECT p.name AS "productName", v.name AS "variantName", sl.quantity,
                  sl.unit_price AS "unitPrice", sl.tax_amount AS "taxAmount", sl.line_total AS "lineTotal"
           FROM sale_lines sl
           JOIN product_variants v ON v.id = sl.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE sl.sale_id = $1 AND sl.org_id = $2
           ORDER BY sl.line_no`,
          [saleId, claims.org],
        );
        const tenders = await tx.query(
          "SELECT tender_type AS \"tenderType\", amount FROM sale_tenders WHERE sale_id = $1 AND org_id = $2 ORDER BY id",
          [saleId, claims.org],
        );

        const { text, html } = renderReceipt(sale.rows[0], lines.rows, tenders.rows);
        const attemptedAt = new Date().toISOString();

        // No provider configured (no RESEND_API_KEY): record 'skipped' and
        // succeed — the till keeps selling, nothing fails offline-first.
        if (!this.sender) {
          await this.upsertAttempt(tx, claims.org, saleId, to, "skipped", attemptedAt, null, "no receipt sender configured");
          await this.audit.write(tx, "receipt.email", "sale", saleId, null, JSON.stringify({ to, status: "skipped" }));
          return { saleId, to, status: "skipped", attemptedAt, replay: Boolean(existingRow) };
        }

        try {
          const { id: providerId } = await this.sender.send({
            from: env.receiptEmailFrom,
            to,
            subject: `Your receipt from ${sale.rows[0].orgName} — P ${Number(sale.rows[0].total).toFixed(2)}`,
            text,
            html,
          });
          await this.upsertAttempt(tx, claims.org, saleId, to, "sent", attemptedAt, providerId, null);
          await this.audit.write(tx, "receipt.email", "sale", saleId, null, JSON.stringify({ to, status: "sent" }));
          return { saleId, to, status: "sent", providerMessageId: providerId, attemptedAt };
        } catch (err) {
          const message = err instanceof Error ? err.message : "send failed";
          // Persist the failed attempt (audit) but keep the op retryable —
          // the next flush tries again and updates the same row.
          await this.upsertAttempt(tx, claims.org, saleId, to, "failed", attemptedAt, null, message);
          await this.audit.write(tx, "receipt.email", "sale", saleId, null, JSON.stringify({ to, status: "failed" }));
          throw new HttpException("Could not send the receipt email", 502);
        }
      },
    );
  }

  private async upsertAttempt(
    tx: import("../db/db.js").DbExecutor,
    orgId: string,
    saleId: string,
    to: string,
    status: "sent" | "failed" | "skipped",
    attemptedAt: string,
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO receipt_emails (org_id, sale_id, to_email, status, error, provider_message_id, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (org_id, sale_id, to_email)
       DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error,
                     provider_message_id = EXCLUDED.provider_message_id,
                     attempted_at = EXCLUDED.attempted_at`,
      [orgId, saleId, to, status, error, providerMessageId, attemptedAt],
    );
  }
}

function fmt(amount: string): string {
  return Number(amount).toFixed(2);
}

function renderReceipt(
  sale: Record<string, unknown>,
  lines: import("../db/migrations.js").Row[],
  tenders: import("../db/migrations.js").Row[],
): { text: string; html: string } {
  const orgName = String(sale.orgName);
  const branchName = String(sale.branchName);
  const total = fmt(String(sale.total));
  const lineRows = lines
    .map(
      (l) =>
        `${String(l.productName)} (${String(l.variantName)}) × ${String(l.quantity)} @ P ${fmt(String(l.unitPrice))} = P ${fmt(String(l.lineTotal))}`,
    )
    .join("\n");
  const tenderRows = tenders
    .map((t) => `${String(t.tenderType).replace("_", " ")}: P ${fmt(String(t.amount))}`)
    .join("\n");

  const text = [
    orgName,
    branchName,
    `Receipt ${String(sale.clientOperationId).slice(0, 8).toUpperCase()}`,
    `Date ${new Date(String(sale.businessTime)).toLocaleString()}`,
    "",
    lineRows,
    "",
    `Total: P ${total}`,
    tenderRows,
    "",
    "Thank you for shopping with us.",
  ].join("\n");

  const htmlLines = lines
    .map(
      (l) =>
        `<tr><td>${String(l.productName)} (${String(l.variantName)})</td><td align="right">${String(l.quantity)} × P ${fmt(String(l.unitPrice))}</td><td align="right">P ${fmt(String(l.lineTotal))}</td></tr>`,
    )
    .join("");
  const htmlTenders = tenders
    .map((t) => `<tr><td>${String(t.tenderType).replace("_", " ")}</td><td align="right">P ${fmt(String(t.amount))}</td></tr>`)
    .join("");

  const html = [
    `<div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">`,
    `<h2>${escapeHtml(orgName)}</h2>`,
    `<p>${escapeHtml(branchName)}<br/>Ref ${String(sale.clientOperationId).slice(0, 8).toUpperCase()}<br/>${new Date(String(sale.businessTime)).toLocaleString()}</p>`,
    `<table style="width: 100%; border-collapse: collapse;">${htmlLines}</table>`,
    `<table style="width: 100%; margin-top: 8px; border-top: 1px solid #ccc;">`,
    `<tr><td><strong>Total</strong></td><td align="right"><strong>P ${total}</strong></td></tr>`,
    `${htmlTenders}</table>`,
    `<p style="color: #666;">Thank you for shopping with us.</p>`,
    `</div>`,
  ].join("\n");

  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

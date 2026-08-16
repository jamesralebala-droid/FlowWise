import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import { env } from "../env.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { MobileMoneyService, createMobileMoneyPayment, createMobileMoneyPayout } from "../mobile-money/mobile-money.service.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;
const TENDER_TYPES = new Set(["cash", "card", "mobile_money", "credit", "other"]);

/** Round to 4dp with banker-safe arithmetic (money is numeric(14,4) in SQL). */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const fmt = (n: number): string => n.toFixed(4);

export interface SaleLineInput {
  variantId: string;
  /** decimal STRING — money/quantity are never floats at any boundary */
  quantity: string;
  /** Optional — FEFO picks the batch automatically when omitted (Phase 2). */
  batchId?: string;
}

interface AllocationRow {
  lineNo: number;
  variantId: string;
  batchId: string | null;
  /** decimal STRING — always positive; ledger rows are signed at insert */
  quantity: string;
}

export interface SaleTenderInput {
  tenderType: string;
  /** decimal STRING — in the tender's currency (defaults to the org base). */
  amount: string;
  reference?: string;
  /** Phase 7: ISO 4217 code; omitted → base currency. cash/card/other only. */
  currency?: string;
}

export interface CreateSaleInput {
  clientOperationId: string;
  branchId: string;
  /** Optional in Phase 1 — the till always provides the open shift. */
  shiftId?: string;
  /** Phase 5: account customer. Required when any tender is 'credit'. */
  customerId?: string;
  /** Phase 6: discount promotion code (validated + usage counted server-side). */
  promotionCode?: string;
  /** Phase 6: loyalty points to spend against the total (requires customerId). */
  loyaltyRedeem?: { points: number };
  notes?: string;
  lines: SaleLineInput[];
  tenders: SaleTenderInput[];
}

export interface RefundSaleInput {
  clientOperationId: string;
  saleId: string;
  amount?: string;
  reason?: string;
}

function assertDecimal(value: string, name: string, allowZero: boolean): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new BadRequestException(`${name} must be a decimal string (up to 4 dp)`);
  }
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0 || (!allowZero && n === 0)) {
    throw new BadRequestException(`${name} must be positive`);
  }
  return value;
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mobileMoney: MobileMoneyService,
  ) {}

  // -- create (complete) ------------------------------------------------------
  async create(claims: JwtPayloadClaims, input: CreateSaleInput): Promise<unknown> {
    const opId = input.clientOperationId?.trim();
    if (!opId) throw new BadRequestException("clientOperationId is required");
    const lines = input.lines ?? [];
    if (lines.length === 0) throw new BadRequestException("a sale needs at least one line");
    for (const [i, l] of lines.entries()) {
      if (typeof l.variantId !== "string" || !l.variantId) throw new BadRequestException(`lines[${i}].variantId is required`);
      assertDecimal(l.quantity, `lines[${i}].quantity`, true);
      if (l.batchId !== undefined && l.batchId !== null && typeof l.batchId !== "string") {
        throw new BadRequestException(`lines[${i}].batchId must be a string`);
      }
    }
    for (const [i, t] of (input.tenders ?? []).entries()) {
      if (!TENDER_TYPES.has(t.tenderType)) throw new BadRequestException(`tenders[${i}].tenderType is invalid`);
      assertDecimal(t.amount, `tenders[${i}].amount`, true);
      if (t.tenderType === "mobile_money" && !t.reference?.trim()) {
        throw new BadRequestException(`tenders[${i}].reference (the customer's mobile number) is required for mobile money`);
      }
    }

    const sale = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        // Invariant 4: a retried upload resolves to the same sale.
        const existing = await tx.query(
          "SELECT id FROM sales WHERE org_id = $1 AND client_operation_id = $2",
          [claims.org, opId],
        );
        if (existing.rows.length > 0) {
          return this.loadSale(tx, claims.org, existing.rows[0].id as string);
        }

        return this.completeSale(tx, claims, { ...input, clientOperationId: opId });
      },
    );

    // Mobile money: drive the provider AFTER the sale transaction commits
    // (never a network call inside the transaction). The payment row was
    // created with the sale; initiateForSale only touches rows still pending.
    const tenders = (sale as { tenders?: { tenderType: string; amount: string; reference?: string | null }[] }).tenders ?? [];
    const mobile = tenders.find((t) => t.tenderType === "mobile_money");
    if (mobile) {
      await this.mobileMoney.initiateForSale(claims, (sale as { id: string }).id, mobile.reference ?? "", mobile.amount);
      // Re-load so the response carries the payment status the provider
      // returned (the first snapshot was taken before initiation).
      const saleId = (sale as { id: string }).id;
      return this.db.withContext(
        { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
        (tx) => this.loadSale(tx, claims.org, saleId),
      );
    }

    return sale;
  }

  private async completeSale(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    input: CreateSaleInput,
  ): Promise<unknown> {
    const org = await tx.query(
      `SELECT vat_rate, currency_code AS "baseCurrency",
              loyalty_earn_points_per_bwp AS "loyaltyEarnRate",
              loyalty_redeem_bwp_per_point AS "loyaltyRedeemValue"
       FROM organisations WHERE id = $1`,
      [claims.org],
    );
    if (org.rows.length === 0) throw new NotFoundException("Organisation not found");
    const taxRate = org.rows[0].vat_rate as string;
    // Phase 7 multi-currency: resolve the FX map (base is always 1).
    const baseCurrency = String(org.rows[0].baseCurrency ?? "BWP").trim();
    const fxRows = await tx.query(
      "SELECT code, rate_to_base AS \"rateToBase\" FROM currencies WHERE org_id = $1",
      [claims.org],
    );
    const fx = new Map<string, string>();
    for (const r of fxRows.rows) fx.set(String(r.code).trim(), String(r.rateToBase));
    if (!fx.has(baseCurrency)) fx.set(baseCurrency, "1");
    const normalizeTender = (t: SaleTenderInput): { tenderType: string; amountBase: string; amountFx: string; fxRate: string; currency: string; reference?: string } => {
      const currency = (t.currency ?? baseCurrency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException(`tender currency ${currency} is invalid`);
      const rate = fx.get(currency);
      if (!rate) throw new BadRequestException(`Unknown tender currency ${currency} — add it in settings first`);
      if (currency !== baseCurrency && (t.tenderType === "mobile_money" || t.tenderType === "credit")) {
        throw new BadRequestException(`${t.tenderType} tender must be in the base currency (${baseCurrency})`);
      }
      const amountBase = currency === baseCurrency ? t.amount : round4(Number(t.amount) * Number(rate)).toFixed(4);
      return {
        tenderType: t.tenderType,
        amountBase,
        amountFx: t.amount,
        fxRate: rate,
        currency,
        reference: t.reference,
      };
    };
    const normalizedTenders = (input.tenders ?? []).map(normalizeTender);

    const branch = await tx.query(
      "SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active",
      [input.branchId, claims.org],
    );
    if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

    // A sale may be tied to the till's open shift; it must exist, belong to
    // the same org AND branch, and still be open (closed shifts take no sales).
    if (input.shiftId) {
      const shift = await tx.query(
        "SELECT id FROM shifts WHERE id = $1 AND org_id = $2 AND branch_id = $3 AND status = 'open'",
        [input.shiftId, claims.org, input.branchId],
      );
      if (shift.rows.length === 0) throw new BadRequestException("Unknown, mismatched, or closed shift");
    }

    // Price resolution + line math — ALL numeric, computed in SQL. line_no
    // preserves the client's scan/request order into the response.
    const values: string[] = [];
    const params: unknown[] = [];
    for (const [i, l] of input.lines.entries()) {
      values.push(`($${params.length + 1}::int, $${params.length + 2}::uuid, $${params.length + 3}::numeric(14,4))`);
      params.push(i + 1, l.variantId, l.quantity);
    }
    const valuesSql = values.join(", ");
    const base = params.length;

    await tx.exec(`CREATE TEMP TABLE _sale_priced (
      line_no int, variant_id uuid, quantity numeric(14,4), unit_price numeric(14,4),
      tax_rate numeric(6,4), line_total numeric(14,4), tax_amount numeric(14,4)
    ) ON COMMIT DROP`);

    await tx.query(
      `INSERT INTO _sale_priced (line_no, variant_id, quantity, unit_price, tax_rate, line_total, tax_amount)
       SELECT r.line_no, r.variant_id, r.quantity, pli.price, $${base + 1}::numeric(6,4),
              round(r.quantity * pli.price, 4), round(r.quantity * pli.price * $${base + 1}, 4)
       FROM (VALUES ${valuesSql}) AS r(line_no, variant_id, quantity)
       JOIN product_variants v ON v.id = r.variant_id AND v.org_id = $${base + 2} AND v.is_active
       JOIN price_list_items pli ON pli.variant_id = r.variant_id AND pli.org_id = $${base + 2}
       JOIN price_lists pl ON pl.id = pli.price_list_id AND pl.is_default
       WHERE pli.valid_from IS NULL AND pli.valid_to IS NULL`,
      [...params, taxRate, claims.org],
    );

    const pricedCount = await tx.query("SELECT count(*)::int AS n FROM _sale_priced");
    if (pricedCount.rows[0].n !== input.lines.length) {
      throw new BadRequestException("One or more lines could not be priced (unknown variant or no default price)");
    }

    const tenderValues: string[] = [];
    const tenderParams: unknown[] = [];
    for (const t of normalizedTenders) {
      tenderValues.push(`($${tenderParams.length + 1}::numeric(14,4))`);
      tenderParams.push(t.amountBase);
    }
    const tenderedRow = await tx.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(14,4) AS tendered
       FROM (VALUES ${tenderValues.length ? tenderValues.join(", ") : "(NULL::numeric(14,4))"}) AS t(amount)`,
      tenderParams,
    );
    const tendered = (tenderedRow.rows[0].tendered as string) ?? "0.0000";

    // Phase 6: promotion + loyalty resolution. Everything is validated BEFORE
    // the sale row is written, and all counters/points rows are written in
    // this same transaction — a failure rolls the whole thing back, so a
    // usage counter or points row can never exist without its document.
    const pricedTotals = await tx.query(
      "SELECT COALESCE(SUM(line_total), 0)::numeric(14,4) AS subtotal, COALESCE(SUM(tax_amount), 0)::numeric(14,4) AS tax_full FROM _sale_priced",
    );
    const subtotal = Number(pricedTotals.rows[0].subtotal);
    const taxAtFull = Number(pricedTotals.rows[0].tax_full);
    const customerId = input.customerId?.trim() || null;

    let promotionId: string | null = null;
    let promotionDiscount = 0;
    if (input.promotionCode?.trim()) {
      const promo = await tx.query(
        `SELECT id, discount_type AS "discountType", discount_value AS "discountValue",
                min_spend AS "minSpend", usage_limit AS "usageLimit", times_used AS "timesUsed",
                starts_at AS "startsAt", ends_at AS "endsAt", is_active AS "isActive"
         FROM promotions WHERE org_id = $1 AND lower(code) = $2`,
        [claims.org, input.promotionCode.trim().toLowerCase()],
      );
      if (promo.rows.length === 0) throw new BadRequestException("Unknown promotion code");
      const p = promo.rows[0];
      if (!p.isActive) throw new BadRequestException("Promotion is not active");
      const nowMs = Date.now();
      if (p.startsAt && new Date(p.startsAt as string).getTime() > nowMs) {
        throw new BadRequestException("Promotion has not started");
      }
      if (p.endsAt && new Date(p.endsAt as string).getTime() < nowMs) {
        throw new BadRequestException("Promotion has ended");
      }
      if (Number(p.minSpend) > subtotal) {
        throw new BadRequestException(`Promotion requires a minimum spend of P ${Number(p.minSpend).toFixed(2)}`);
      }
      if (p.usageLimit !== null && Number(p.timesUsed) >= Number(p.usageLimit)) {
        throw new BadRequestException("Promotion usage limit reached");
      }
      promotionDiscount =
        p.discountType === "percentage"
          ? round4(subtotal * Number(p.discountValue))
          : Math.min(Number(p.discountValue), subtotal);
      if (promotionDiscount <= 0) throw new BadRequestException("Promotion yields no discount on this basket");
      promotionId = p.id as string;
    }

    // Loyalty: points the customer chooses to spend (a second discount
    // component, capped at the payable). The balance is a derived view.
    let loyaltyPointsUsed = 0;
    let loyaltyCredit = 0;
    if (input.loyaltyRedeem && Number(input.loyaltyRedeem.points) > 0) {
      if (!customerId) throw new BadRequestException("customerId is required to redeem loyalty points");
      const points = Number(input.loyaltyRedeem.points);
      if (!Number.isInteger(points) || points <= 0) {
        throw new BadRequestException("loyaltyRedeem.points must be a positive integer");
      }
      const bal = await tx.query(
        "SELECT COALESCE(points, 0)::int AS points FROM v_customer_loyalty WHERE org_id = $1 AND customer_id = $2",
        [claims.org, customerId],
      );
      if (Number(bal.rows[0].points) < points) throw new BadRequestException("Insufficient loyalty points");
      loyaltyPointsUsed = points;
    }

    // Discounts shrink the taxable base proportionally (per-line tax rates
    // stay exact), then loyalty credit comes off the payable.
    const taxable = subtotal - promotionDiscount;
    const taxTotal = subtotal > 0 ? round4(taxAtFull * (taxable / subtotal)) : 0;
    const payable = round4(taxable + taxTotal);
    if (loyaltyPointsUsed > 0) {
      loyaltyCredit = Math.min(round4(loyaltyPointsUsed * Number(org.rows[0].loyaltyRedeemValue)), payable);
    }
    const total = round4(payable - loyaltyCredit);
    const earnedPoints = customerId && total > 0 ? Math.floor(total * Number(org.rows[0].loyaltyEarnRate)) : 0;

    // Phase 5 credit: the credit tender portion becomes a receivable on the
    // customer's account IN THE SAME TRANSACTION as the sale (Invariant 3).
    const creditTenders = normalizedTenders.filter((t) => t.tenderType === "credit");
    let creditPortion = "0.0000";
    if (creditTenders.length > 0) {
      if (!customerId) throw new BadRequestException("customerId is required for credit sales");
      const creditSum = await tx.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(14,4) AS credit
         FROM (VALUES ${creditTenders.map((_, i) => `($${i + 1}::numeric(14,4))`).join(", ")}) AS t(amount)`,
        creditTenders.map((t) => t.amountBase),
      );
      creditPortion = creditSum.rows[0].credit as string;

      const customer = await tx.query(
        `SELECT c.id, c.credit_limit AS "creditLimit", COALESCE(b.balance, 0)::numeric(14,4) AS balance
         FROM customers c
         LEFT JOIN v_customer_balances b ON b.customer_id = c.id AND b.org_id = c.org_id
         WHERE c.id = $1 AND c.org_id = $2 AND c.is_active`,
        [customerId, claims.org],
      );
      if (customer.rows.length === 0) throw new BadRequestException("Unknown or inactive customer");
      if (Number(customer.rows[0].creditLimit) <= 0) {
        throw new BadRequestException("This customer has no credit limit — cash/card only");
      }
      if (Number(customer.rows[0].balance) + Number(creditPortion) > Number(customer.rows[0].creditLimit)) {
        throw new BadRequestException("Credit sale exceeds the customer's credit limit");
      }
    }

    const sale = await tx.query(
      `INSERT INTO sales
         (org_id, branch_id, user_id, device_id, shift_id, customer_id, client_operation_id, status,
          subtotal, discount, tax_total, total, tendered, change_due,
          promotion_id, loyalty_points_used, loyalty_credit, notes, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed',
               $8::numeric(14,4), $9::numeric(14,4), $10::numeric(14,4), $11::numeric(14,4),
               $12::numeric(14,4), GREATEST($12::numeric(14,4) - $11::numeric(14,4), 0),
               $13, $14::int, $15::numeric(14,4), $16, now())
       RETURNING id, subtotal, discount, tax_total, total, tendered, change_due`,
      [
        claims.org,
        input.branchId,
        claims.sub,
        claims.dev ?? null,
        input.shiftId ?? null,
        customerId,
        input.clientOperationId,
        fmt(subtotal),
        fmt(promotionDiscount),
        fmt(taxTotal),
        fmt(total),
        tendered,
        promotionId,
        loyaltyPointsUsed,
        fmt(loyaltyCredit),
        input.notes ?? null,
      ],
    );
    const saleId = sale.rows[0].id as string;

    // Credit portion → receivable (debt increases). Replay-safe via the
    // sale's own client_operation_id (Invariant 4); the sale replay path
    // returns early, so this row is written exactly once.
    if (Number(creditPortion) > 0) {
      await tx.query(
        `INSERT INTO customer_ledger
           (org_id, customer_id, branch_id, entry_type, amount, reference_type, reference_id,
            notes, client_operation_id, business_time, created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, 'sale', $4::numeric(14,4), 'sale', $5,
                 $6, 'sale:' || $7, now(), $8, $9)`,
        [
          claims.org,
          customerId,
          input.branchId,
          creditPortion,
          saleId,
          "Credit sale" + (input.notes ? ` — ${input.notes}` : ""),
          input.clientOperationId,
          claims.sub,
          claims.dev ?? null,
        ],
      );
    }

    // Promotion usage counter — same transaction as the sale (never drifts).
    if (promotionId) {
      await tx.query("UPDATE promotions SET times_used = times_used + 1 WHERE id = $1 AND org_id = $2", [
        promotionId,
        claims.org,
      ]);
    }

    // Loyalty earn/redeem — append-only rows, replay-safe on the client op id.
    if (customerId && earnedPoints > 0) {
      await tx.query(
        `INSERT INTO loyalty_transactions
           (org_id, customer_id, sale_id, entry_type, points, reference_type, reference_id, notes,
            client_operation_id, business_time, created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, 'earn', $4::int, 'sale', $5, $6, $7, now(), $8, $9)
         ON CONFLICT (org_id, client_operation_id) DO NOTHING`,
        [
          claims.org,
          customerId,
          saleId,
          earnedPoints,
          saleId,
          `Earned on sale ${input.clientOperationId.slice(0, 8).toUpperCase()}`,
          `sale:${input.clientOperationId}:loyalty:earn`,
          claims.sub,
          claims.dev ?? null,
        ],
      );
    }
    if (customerId && loyaltyPointsUsed > 0) {
      await tx.query(
        `INSERT INTO loyalty_transactions
           (org_id, customer_id, sale_id, entry_type, points, reference_type, reference_id, notes,
            client_operation_id, business_time, created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, 'redeem', -$4::int, 'sale', $5, $6, $7, now(), $8, $9)
         ON CONFLICT (org_id, client_operation_id) DO NOTHING`,
        [
          claims.org,
          customerId,
          saleId,
          loyaltyPointsUsed,
          saleId,
          `Loyalty redemption P ${fmt(loyaltyCredit)}`,
          `sale:${input.clientOperationId}:loyalty:redeem`,
          claims.sub,
          claims.dev ?? null,
        ],
      );
    }

    // Mobile money tender → pending payment row IN this transaction (Invariant 3).
    for (const t of normalizedTenders) {
      if (t.tenderType !== "mobile_money") continue;
      await createMobileMoneyPayment(
        tx,
        claims.org,
        input.branchId,
        saleId,
        env.mobileMoneyProvider,
        t.reference!.trim(),
        t.amountBase,
        input.clientOperationId,
      );
    }

    // Phase 2 FEFO: resolve the batch(es) each line draws from before writing
    // anything (explicit batch or auto-pick by expiry; oversell rejected).
    const { allocation, lineBatch } = await this.allocateBatches(tx, claims, input.branchId, input.lines);

    // $1/$2 are org_id and sale_id; the batch mapping starts at $3.
    const lineBatchValues: string[] = [];
    const lineBatchParams: unknown[] = [claims.org, saleId];
    for (const _l of input.lines) {
      const lineNo = lineBatchValues.length + 1;
      const batchId = lineBatch.get(lineNo) ?? null;
      lineBatchValues.push(`($${lineBatchParams.length + 1}::int, $${lineBatchParams.length + 2}::uuid)`);
      lineBatchParams.push(lineNo, batchId);
    }

    await tx.query(
      `INSERT INTO sale_lines (org_id, sale_id, line_no, variant_id, quantity, unit_price, tax_rate, tax_amount, line_total, batch_id)
       SELECT $1, $2, p.line_no, p.variant_id, p.quantity, p.unit_price, p.tax_rate, p.tax_amount, p.line_total, lb.batch_id
       FROM _sale_priced p
       LEFT JOIN (VALUES ${lineBatchValues.join(", ")}) AS lb(line_no, batch_id) ON lb.line_no = p.line_no`,
      lineBatchParams,
    );

    for (const [i, t] of normalizedTenders.entries()) {
      await tx.query(
        `INSERT INTO sale_tenders (org_id, sale_id, tender_type, amount, reference, tender_currency, fx_rate, amount_fx)
         VALUES ($1, $2, $3, $4::numeric(14,4), $5, $6, $7::numeric(14,8), $8::numeric(14,4))`,
        [claims.org, saleId, t.tenderType, t.amountBase, t.reference ?? null, t.currency, t.fxRate, t.amountFx],
      );
    }

    // Ledger rows — the ONLY way stock changes for a sale (Invariant 1/2/3).
    // One row per allocated batch (a FEFO split writes one row per batch).
    for (const a of allocation) {
      await tx.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
            reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, 'sale', -$4::numeric(14,4), NULL, $5,
                 'sale', $6, 'sale:' || $7 || ':' || $8 || ':' || COALESCE($9::text, 'none'), now(), $10, $11)`,
        [claims.org, input.branchId, a.variantId, a.quantity, a.batchId, saleId, input.clientOperationId, a.lineNo, a.batchId, claims.sub, claims.dev ?? null],
      );
    }

    await this.audit.write(
      tx,
      "sale.complete",
      "sale",
      saleId,
      null,
      JSON.stringify({ total: sale.rows[0].total, lines: input.lines.length }),
    );

    return this.loadSale(tx, claims.org, saleId);
  }

  /**
   * Phase 2 FEFO batch resolution for a sale.
   * - Explicit batchId on a line → that batch only (same org, variant, and
   *   enough on-hand at the branch — oversell rejected).
   * - No batchId and the variant is batch-tracked → FEFO split across
   *   batches (earliest expiry first); rejected if on-hand can't cover the
   *   line (oversell resolution — never silent negative stock).
   * - No batchId and no batches → plain (non-batch) movement, as in Phase 1.
   * Within one sale, allocations never exceed the same batch twice.
   */
  private async allocateBatches(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    branchId: string,
    lines: SaleLineInput[],
  ): Promise<{ allocation: AllocationRow[]; lineBatch: Map<number, string | null> }> {
    const allocation: AllocationRow[] = [];
    const lineBatch = new Map<number, string | null>();
    const used = new Map<string, number>();

    const priced = await tx.query("SELECT line_no, variant_id, quantity FROM _sale_priced ORDER BY line_no");
    for (const row of priced.rows) {
      const lineNo = row.line_no as number;
      const variantId = row.variant_id as string;
      const quantity = row.quantity as string;
      const explicit = (lines[lineNo - 1] as SaleLineInput | undefined)?.batchId ?? null;

      if (explicit) {
        const b = await tx.query(
          `SELECT b.id,
                  COALESCE((SELECT SUM(sl.quantity) FROM stock_ledger sl
                            WHERE sl.batch_id = b.id AND sl.branch_id = $2), 0)::numeric(14,4) AS on_hand
           FROM batches b
           WHERE b.id = $1 AND b.org_id = $3 AND b.variant_id = $4`,
          [explicit, branchId, claims.org, variantId],
        );
        if (b.rows.length === 0) throw new BadRequestException(`line ${lineNo}: unknown batch for this variant`);
        const available = Number(b.rows[0].on_hand) - (used.get(explicit) ?? 0);
        if (available < Number(quantity)) {
          throw new BadRequestException(`line ${lineNo}: insufficient stock in the selected batch`);
        }
        used.set(explicit, (used.get(explicit) ?? 0) + Number(quantity));
        allocation.push({ lineNo, variantId, batchId: explicit, quantity });
        lineBatch.set(lineNo, explicit);
        continue;
      }

      const batches = await tx.query(
        `SELECT b.id, COALESCE(SUM(sl.quantity), 0)::numeric(14,4) AS on_hand
         FROM batches b
         LEFT JOIN stock_ledger sl ON sl.batch_id = b.id AND sl.branch_id = $1
         WHERE b.org_id = $2 AND b.variant_id = $3
         GROUP BY b.id
         HAVING SUM(sl.quantity) > 0
         ORDER BY b.expiry_date NULLS LAST, b.created_at`,
        [branchId, claims.org, variantId],
      );

      if (batches.rows.length === 0) {
        allocation.push({ lineNo, variantId, batchId: null, quantity });
        lineBatch.set(lineNo, null);
        continue;
      }

      let remaining = Number(quantity);
      const picks: { id: string; qty: string }[] = [];
      for (const b of batches.rows) {
        if (remaining <= 0) break;
        const available = Number(b.on_hand) - (used.get(b.id as string) ?? 0);
        if (available <= 0) continue;
        const take = Math.min(available, remaining);
        picks.push({ id: b.id as string, qty: take.toFixed(4) });
        used.set(b.id as string, (used.get(b.id as string) ?? 0) + take);
        remaining -= take;
      }
      if (remaining > 0.0000001) {
        throw new BadRequestException(`line ${lineNo}: insufficient stock on hand (batch-tracked variant)`);
      }
      for (const p of picks) allocation.push({ lineNo, variantId, batchId: p.id, quantity: p.qty });
      lineBatch.set(lineNo, picks.length === 1 ? picks[0].id : null);
    }
    return { allocation, lineBatch };
  }

  // -- refund -------------------------------------------------------------------
  async refund(claims: JwtPayloadClaims, input: RefundSaleInput): Promise<unknown> {
    const opId = input.clientOperationId?.trim();
    if (!opId) throw new BadRequestException("clientOperationId is required");

    let payoutInfo: { phone: string; amount: string; providerReference: string | null } | null = null;
    const result = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query(
          "SELECT id FROM sale_refunds WHERE org_id = $1 AND client_operation_id = $2",
          [claims.org, opId],
        );
        if (existing.rows.length > 0) {
          return { refundId: existing.rows[0].id, replay: true };
        }

        const sale = await tx.query(
          "SELECT id, branch_id, total FROM sales WHERE id = $1 AND org_id = $2",
          [input.saleId, claims.org],
        );
        if (sale.rows.length === 0) throw new NotFoundException("Sale not found");
        const amount = input.amount ? assertDecimal(input.amount, "amount", true) : sale.rows[0].total as string;
        if (Number(amount) > Number(sale.rows[0].total)) {
          throw new BadRequestException("Refund amount exceeds the sale total");
        }

        const refund = await tx.query(
          `INSERT INTO sale_refunds (org_id, sale_id, user_id, device_id, client_operation_id, amount, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [claims.org, input.saleId, claims.sub, claims.dev ?? null, opId, amount, input.reason ?? null],
        );
        const refundId = refund.rows[0].id as string;

        // A refund of a credit sale reduces the receivable by the refunded
        // amount (capped at the credit portion) — same transaction, Invariant 3.
        const creditSale = await tx.query(
          `SELECT s.customer_id AS "customerId",
                  COALESCE((SELECT SUM(st.amount) FROM sale_tenders st
                            WHERE st.sale_id = s.id AND st.tender_type = 'credit'), 0)::numeric(14,4) AS credit
           FROM sales s WHERE s.id = $1 AND s.org_id = $2`,
          [input.saleId, claims.org],
        );
        const creditCustomer = creditSale.rows[0]?.customerId as string | undefined;
        const creditPortion = (creditSale.rows[0]?.credit as string) ?? "0.0000";
        if (creditCustomer && Number(creditPortion) > 0) {
          const reduction = Number(amount) <= Number(creditPortion) ? amount : creditPortion;
          await tx.query(
            `INSERT INTO customer_ledger
               (org_id, customer_id, branch_id, entry_type, amount, reference_type, reference_id,
                notes, client_operation_id, business_time, created_by_user_id, created_by_device_id)
             VALUES ($1, $2, $3, 'refund', -$4::numeric(14,4), 'sale_refund', $5,
                     'Refund reduces credit portion', 'refund:' || $6, now(), $7, $8)`,
            [claims.org, creditCustomer, sale.rows[0].branch_id as string, reduction, refundId, opId, claims.sub, claims.dev ?? null],
          );
        }

        // Loyalty: reverse exactly what the sale earned/spent (append-only,
        // replay-safe on the refund's client op id). Spending points before a
        // refund can push a balance negative — future earnings offset it.
        if (creditCustomer) {
          const loyalty = await tx.query(
            `SELECT entry_type AS "entryType", points
             FROM loyalty_transactions
             WHERE org_id = $1 AND sale_id = $2 AND entry_type IN ('earn', 'redeem')`,
            [claims.org, input.saleId],
          );
          for (const row of loyalty.rows) {
            const kind = row.entryType === "earn" ? "earn" : "redeem";
            await tx.query(
              `INSERT INTO loyalty_transactions
                 (org_id, customer_id, sale_id, entry_type, points, reference_type, reference_id, notes,
                  client_operation_id, business_time, created_by_user_id, created_by_device_id)
               VALUES ($1, $2, NULL, 'refund_reverse', -$3::int, 'sale_refund', $4, $5, $6, now(), $7, $8)
               ON CONFLICT (org_id, client_operation_id) DO NOTHING`,
              [
                claims.org,
                creditCustomer,
                row.points,
                refundId,
                `Refund reverses ${kind} (${String(row.points)} pts)`,
                `refund:${opId}:loyalty:${kind}`,
                claims.sub,
                claims.dev ?? null,
              ],
            );
          }
        }

        // Reverse the ORIGINAL sale's ledger rows, per batch — restoration is
        // faithful to exactly what was sold (batch-aware; reproducible from
        // the ledger alone, never from client claims).
        await tx.query(
          `INSERT INTO stock_ledger
             (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
              reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id)
           SELECT $1, $2, sl.variant_id, 'sale_refund', -sl.quantity, sl.unit_cost, sl.batch_id,
                  'sale', $3, 'refund:' || $4 || ':' || sl.variant_id || ':' || COALESCE(sl.batch_id::text, 'none'),
                  now(), $5, $6
           FROM stock_ledger sl
           WHERE sl.reference_type = 'sale' AND sl.reference_id = $3 AND sl.org_id = $1`,
          [claims.org, sale.rows[0].branch_id as string, input.saleId, opId, claims.sub, claims.dev ?? null],
        );

        // Phase 7: a refund of a mobile-money-paid sale pays the customer back
        // to their wallet. The payout row is created IN this transaction
        // (Invariant 3); the provider refund() runs after commit.
        if (Number(amount) > 0) {
          const mobile = await tx.query(
            `SELECT id, provider, phone, amount, provider_reference AS "providerReference"
             FROM mobile_money_payments
             WHERE sale_id = $1 AND org_id = $2 AND status = 'confirmed'`,
            [input.saleId, claims.org],
          );
          if (mobile.rows.length > 0) {
            const m = mobile.rows[0];
            const payoutAmount = fmt(Math.min(Number(amount), Number(m.amount)));
            await createMobileMoneyPayout(
              tx,
              claims.org,
              sale.rows[0].branch_id as string,
              m.id as string,
              input.saleId,
              refundId,
              m.provider as string,
              m.phone as string,
              payoutAmount,
              opId,
            );
            payoutInfo = {
              phone: m.phone as string,
              amount: payoutAmount,
              providerReference: (m.providerReference as string | null) ?? null,
            };
          }
        }

        await this.audit.write(tx, "sale.refund", "sale", input.saleId, null, JSON.stringify({ refundId, amount }));

        return { refundId, amount, saleId: input.saleId };
      },
    );

    // Mobile-money refund: drive the provider AFTER the refund transaction
    // commits (never a network call inside the transaction). A provider
    // failure marks the payout 'failed' — the refund itself already stands.
    if (payoutInfo && !(result as { replay?: boolean }).replay) {
      const { phone, amount, providerReference } = payoutInfo;
      await this.mobileMoney.refundForSale(claims, (result as { refundId: string }).refundId, input.saleId, phone, amount, providerReference);
      return { ...result, payout: { phone, amount } };
    }
    return result;
  }

  // -- read ----------------------------------------------------------------------
  async get(claims: JwtPayloadClaims, saleId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.loadSale(tx, claims.org, saleId),
    );
  }

  /**
   * Pull half of the outbox sync: sales completed after a cursor, for a
   * branch. Returns full documents (lines + tenders) so a device can replay
   * them into its local store and advance sync_cursors.
   */
  async list(
    claims: JwtPayloadClaims,
    opts: { branchId?: string; since?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1", "status = 'completed'"];
        const params: unknown[] = [claims.org];
        if (opts.branchId) {
          params.push(opts.branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        if (opts.since) {
          params.push(opts.since);
          clauses.push(`business_time > $${params.length}`);
        }
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
        params.push(limit);
        const ids = await tx.query(
          `SELECT id FROM sales WHERE ${clauses.join(" AND ")}
           ORDER BY business_time ASC LIMIT $${params.length}`,
          params,
        );
        const sales = [];
        for (const row of ids.rows) {
          sales.push(await this.loadSale(tx, claims.org, row.id as string));
        }
        return { sales };
      },
    );
  }

  private async loadSale(tx: DbExecutor, orgId: string, saleId: string): Promise<unknown> {
    const sale = await tx.query(
      `SELECT id, branch_id AS "branchId", user_id AS "userId", device_id AS "deviceId",
              shift_id AS "shiftId", customer_id AS "customerId", client_operation_id AS "clientOperationId", status,
              subtotal, discount, tax_total AS "taxTotal", total, tendered,
              change_due AS "changeDue", promotion_id AS "promotionId",
              loyalty_points_used AS "loyaltyPointsUsed", loyalty_credit AS "loyaltyCredit",
              business_time AS "businessTime", notes,
              completed_at AS "completedAt"
       FROM sales WHERE id = $1 AND org_id = $2`,
      [saleId, orgId],
    );
    if (sale.rows.length === 0) throw new NotFoundException("Sale not found");

    const lines = await tx.query(
      `SELECT id, line_no AS "lineNo", variant_id AS "variantId", quantity, unit_price AS "unitPrice",
              tax_rate AS "taxRate", tax_amount AS "taxAmount", line_total AS "lineTotal",
              batch_id AS "batchId"
       FROM sale_lines WHERE sale_id = $1 AND org_id = $2 ORDER BY line_no`,
      [saleId, orgId],
    );
    const tenders = await tx.query(
      `SELECT id, tender_type AS "tenderType", amount, reference,
              tender_currency AS "tenderCurrency", fx_rate AS "fxRate", amount_fx AS "amountFx"
       FROM sale_tenders WHERE sale_id = $1 AND org_id = $2 ORDER BY id`,
      [saleId, orgId],
    );
    const payments = await tx.query(
      `SELECT id, provider, phone, amount, status, provider_reference AS "providerReference",
              provider_status AS "providerStatus", error, confirmed_at AS "confirmedAt", created_at AS "createdAt"
       FROM mobile_money_payments WHERE sale_id = $1 AND org_id = $2 ORDER BY created_at`,
      [saleId, orgId],
    );
    const payouts = await tx.query(
      `SELECT id, provider, phone, amount, status, provider_reference AS "providerReference",
              provider_status AS "providerStatus", error, confirmed_at AS "confirmedAt", created_at AS "createdAt"
       FROM mobile_money_payouts WHERE sale_id = $1 AND org_id = $2 ORDER BY created_at`,
      [saleId, orgId],
    );
    return { ...sale.rows[0], lines: lines.rows, tenders: tenders.rows, payments: payments.rows, payouts: payouts.rows };
  }
}

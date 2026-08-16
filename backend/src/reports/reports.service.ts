import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

export interface ReportFilters {
  branchId?: string;
  from?: string;
  to?: string;
}

interface PeriodWhere {
  where: string;
  params: unknown[];
  /** positional parameter index for each filter that is present (0 = absent) */
  slots: { branch: number; from: number; to: number };
}

/**
 * Org-scoped WHERE for report queries. Filters are bound in a fixed order
 * (org, branch, from, to) so the same placeholders can be reused verbatim in
 * a nested subquery (positional params share values across the statement).
 */
function periodWhere(orgId: string, f: ReportFilters, alias: string): PeriodWhere {
  const params: unknown[] = [orgId];
  const clauses = [`${alias}.org_id = $1`];
  const slots = { branch: 0, from: 0, to: 0 };

  if (f.branchId) {
    slots.branch = params.length + 1;
    params.push(f.branchId);
    clauses.push(`${alias}.branch_id = $${slots.branch}`);
  }
  if (f.from) {
    const d = new Date(f.from);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("from must be an ISO timestamp");
    slots.from = params.length + 1;
    params.push(d.toISOString());
    clauses.push(`${alias}.business_time >= $${slots.from}`);
  }
  if (f.to) {
    const d = new Date(f.to);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("to must be an ISO timestamp");
    slots.to = params.length + 1;
    params.push(d.toISOString());
    clauses.push(`${alias}.business_time <= $${slots.to}`);
  }
  return { where: clauses.join(" AND "), params, slots };
}

function refundSubqueryWhere(slots: PeriodWhere["slots"]): string {
  const clauses = ["s2.org_id = $1", "s2.status = 'completed'"];
  if (slots.branch) clauses.push(`s2.branch_id = $${slots.branch}`);
  if (slots.from) clauses.push(`s2.business_time >= $${slots.from}`);
  if (slots.to) clauses.push(`s2.business_time <= $${slots.to}`);
  return clauses.join(" AND ");
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async salesSummary(claims: JwtPayloadClaims, f: ReportFilters): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        if (f.branchId) {
          const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [f.branchId, claims.org]);
          if (b.rows.length === 0) throw new BadRequestException("Unknown branch");
        }
        const { where, params, slots } = periodWhere(claims.org, f, "s");

        const totals = await tx.query(
          `SELECT count(*)::int AS "salesCount",
                  COALESCE(SUM(s.subtotal), 0)::numeric(14,4) AS subtotal,
                  COALESCE(SUM(s.tax_total), 0)::numeric(14,4) AS "taxTotal",
                  COALESCE(SUM(s.total), 0)::numeric(14,4) AS total,
                  COALESCE((SELECT SUM(r.amount)
                            FROM sale_refunds r JOIN sales s2 ON s2.id = r.sale_id
                            WHERE ${refundSubqueryWhere(slots)}), 0)::numeric(14,4) AS "refundTotal"
           FROM sales s
           WHERE ${where} AND s.status = 'completed'`,
          params,
        );

        const tenders = await tx.query(
          `SELECT st.tender_type AS "tenderType",
                  COALESCE(SUM(st.amount), 0)::numeric(14,4) AS amount,
                  count(*)::int AS count
           FROM sale_tenders st JOIN sales s ON s.id = st.sale_id
           WHERE ${where} AND s.status = 'completed'
           GROUP BY st.tender_type ORDER BY st.tender_type`,
          params,
        );

        const row = totals.rows[0];
        const salesCount = Number(row.salesCount);
        const total = Number(row.total);
        const refundTotal = Number(row.refundTotal);
        const netTotal = (total - refundTotal).toFixed(4);
        const averageSale = salesCount > 0 ? (total / salesCount).toFixed(4) : "0.0000";

        return {
          period: { from: f.from ?? null, to: f.to ?? null },
          branchId: f.branchId ?? null,
          totals: { ...row, netTotal, averageSale },
          tenders: tenders.rows,
        };
      },
    );
  }

  async dailySales(claims: JwtPayloadClaims, f: ReportFilters): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        if (f.branchId) {
          const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [f.branchId, claims.org]);
          if (b.rows.length === 0) throw new BadRequestException("Unknown branch");
        }
        const { where, params } = periodWhere(claims.org, f, "s");

        const r = await tx.query(
          `SELECT (s.business_time AT TIME ZONE o.timezone)::date AS day,
                  count(*)::int AS "salesCount",
                  COALESCE(SUM(s.total), 0)::numeric(14,4) AS total,
                  COALESCE(SUM(s.tax_total), 0)::numeric(14,4) AS "taxTotal"
           FROM sales s
           JOIN organisations o ON o.id = s.org_id
           WHERE ${where} AND s.status = 'completed'
           GROUP BY day ORDER BY day`,
          params,
        );
        return { daily: r.rows };
      },
    );
  }

  /**
   * Phase 5: stock valuation per branch — quantity on hand × latest landed
   * unit cost (from the ledger; receipts carry the true landed cost).
   */
  async stockValuation(claims: JwtPayloadClaims, f: ReportFilters): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        if (f.branchId) {
          const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [f.branchId, claims.org]);
          if (b.rows.length === 0) throw new BadRequestException("Unknown branch");
        }
        const params: unknown[] = [claims.org];
        const clauses = ["ii.org_id = $1", "ii.quantity_on_hand <> 0"];
        if (f.branchId) {
          params.push(f.branchId);
          clauses.push(`ii.branch_id = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT ii.branch_id AS "branchId", b.name AS "branchName",
                  count(*)::int AS variants,
                  COALESCE(SUM(ii.quantity_on_hand * c.unit_cost), 0)::numeric(14,4) AS value
           FROM inventory_items ii
           JOIN branches b ON b.id = ii.branch_id
           JOIN LATERAL (
             SELECT sl.unit_cost FROM stock_ledger sl
             WHERE sl.variant_id = ii.variant_id AND sl.branch_id = ii.branch_id
               AND sl.unit_cost IS NOT NULL
             ORDER BY sl.business_time DESC, sl.id DESC LIMIT 1
           ) c ON true
           WHERE ${clauses.join(" AND ")}
           GROUP BY ii.branch_id, b.name
           ORDER BY value DESC`,
          params,
        );
        const total = r.rows.reduce((acc, row) => acc + Number(row.value), 0).toFixed(4);
        return { branchId: f.branchId ?? null, total, rows: r.rows };
      },
    );
  }

  /**
   * Phase 5: margin per variant over a period. COGS uses the current landed
   * cost (latest ledger cost per variant+branch) — documented approximation,
   * exact when costs are stable.
   */
  async margin(claims: JwtPayloadClaims, f: ReportFilters): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        if (f.branchId) {
          const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [f.branchId, claims.org]);
          if (b.rows.length === 0) throw new BadRequestException("Unknown branch");
        }
        const { where, params } = periodWhere(claims.org, f, "s");
        const r = await tx.query(
          `SELECT v.id AS "variantId", p.name AS "productName", v.name AS "variantName",
                  COALESCE(SUM(sl2.quantity), 0)::numeric(14,4) AS "unitsSold",
                  COALESCE(SUM(sl2.line_total), 0)::numeric(14,4) AS revenue,
                  COALESCE(SUM(sl2.quantity * c.unit_cost), 0)::numeric(14,4) AS cogs,
                  COALESCE(SUM(sl2.line_total) - SUM(sl2.quantity * c.unit_cost), 0)::numeric(14,4) AS margin
           FROM sale_lines sl2
           JOIN sales s ON s.id = sl2.sale_id
           JOIN product_variants v ON v.id = sl2.variant_id
           JOIN products p ON p.id = v.product_id
           JOIN LATERAL (
             SELECT sl.unit_cost FROM stock_ledger sl
             WHERE sl.variant_id = v.id AND sl.branch_id = s.branch_id
               AND sl.unit_cost IS NOT NULL
             ORDER BY sl.business_time DESC, sl.id DESC LIMIT 1
           ) c ON true
           WHERE ${where} AND s.status = 'completed'
           GROUP BY v.id, p.name, v.name
           ORDER BY margin DESC
           LIMIT 100`,
          params,
        );
        return { branchId: f.branchId ?? null, rows: r.rows };
      },
    );
  }

  /** Phase 5: top products by revenue over a period (default 10). */
  async topProducts(claims: JwtPayloadClaims, f: ReportFilters & { limit?: number }): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        if (f.branchId) {
          const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2", [f.branchId, claims.org]);
          if (b.rows.length === 0) throw new BadRequestException("Unknown branch");
        }
        const limit = Math.min(Math.max(f.limit ?? 10, 1), 50);
        const { where, params } = periodWhere(claims.org, f, "s");
        params.push(limit);
        const r = await tx.query(
          `SELECT v.id AS "variantId", p.name AS "productName", v.name AS "variantName",
                  COALESCE(SUM(sl2.quantity), 0)::numeric(14,4) AS "unitsSold",
                  COALESCE(SUM(sl2.line_total), 0)::numeric(14,4) AS revenue
           FROM sale_lines sl2
           JOIN sales s ON s.id = sl2.sale_id
           JOIN product_variants v ON v.id = sl2.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE ${where} AND s.status = 'completed'
           GROUP BY v.id, p.name, v.name
           ORDER BY revenue DESC
           LIMIT $${params.length}`,
          params,
        );
        return { branchId: f.branchId ?? null, rows: r.rows };
      },
    );
  }
}

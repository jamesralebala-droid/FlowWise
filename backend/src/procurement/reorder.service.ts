import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDecimal, requireString } from "../inventory/validate.js";

export interface ReorderRuleInput {
  branchId: string;
  variantId: string;
  /** decimal STRING */
  reorderPoint: string;
  /** decimal STRING */
  reorderQuantity: string;
  leadTimeDays?: number;
  safetyStockDays?: number;
  demandWindowDays?: number;
  isActive?: boolean;
}

export interface EvaluateInput {
  branchId: string;
}

const RULE_COLS = `id, branch_id AS "branchId", variant_id AS "variantId", reorder_point AS "reorderPoint",
  reorder_quantity AS "reorderQuantity", lead_time_days AS "leadTimeDays", safety_stock_days AS "safetyStockDays",
  demand_window_days AS "demandWindowDays", is_active AS "isActive", created_at AS "createdAt"`;

interface RuleRow {
  id: string;
  branch_id: string;
  variant_id: string;
  reorder_point: string;
  reorder_quantity: string;
  lead_time_days: number;
  safety_stock_days: number;
  demand_window_days: number;
}

interface DemandRow {
  units_sold: string;
  sale_count: number;
}

/**
 * Phase 3 — reorder rules, demand forecast and the suggestion evaluator.
 *
 * The evaluator is deliberately explainable: every suggestion carries the
 * inputs it was computed from (current stock, reorder point, trailing-window
 * average daily demand, lead time, safety stock) plus a human-readable reason.
 * Rule fields win; a variant with no rule falls back to its Phase 2
 * variant-level reorder_level/reorder_quantity so existing low-stock config
 * keeps working. Running the evaluator regenerates the branch's OPEN
 * suggestions (dismissed/converted ones are left untouched).
 */
@Injectable()
export class ReorderService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Create or update the rule for (branch, variant) — upsert by design. */
  async upsertRule(claims: JwtPayloadClaims, input: ReorderRuleInput): Promise<unknown> {
    const branchId = requireString(input.branchId, "branchId");
    const variantId = requireString(input.variantId, "variantId");
    const reorderPoint = assertDecimal(input.reorderPoint, "reorderPoint", { allowZero: true });
    const reorderQuantity = assertDecimal(input.reorderQuantity, "reorderQuantity", { allowZero: false });

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        await this.assertBranchVariant(tx, claims.org, branchId, variantId);

        const r = await tx.query(
          `INSERT INTO reorder_rules
             (org_id, branch_id, variant_id, reorder_point, reorder_quantity, lead_time_days,
              safety_stock_days, demand_window_days, is_active, created_by_user_id)
           VALUES ($1, $2, $3, $4::numeric(14,4), $5::numeric(14,4), $6, $7, $8, $9, $10)
           ON CONFLICT (org_id, branch_id, variant_id) DO UPDATE SET
             reorder_point = EXCLUDED.reorder_point,
             reorder_quantity = EXCLUDED.reorder_quantity,
             lead_time_days = EXCLUDED.lead_time_days,
             safety_stock_days = EXCLUDED.safety_stock_days,
             demand_window_days = EXCLUDED.demand_window_days,
             is_active = EXCLUDED.is_active,
             updated_at = now()
           RETURNING ${RULE_COLS}`,
          [
            claims.org,
            branchId,
            variantId,
            reorderPoint,
            reorderQuantity,
            this.intOr(input.leadTimeDays, 0, "leadTimeDays"),
            this.intOr(input.safetyStockDays, 0, "safetyStockDays"),
            this.intOr(input.demandWindowDays, 30, "demandWindowDays", { min: 1, max: 365 }),
            input.isActive ?? true,
            claims.sub,
          ],
        );

        await this.audit.write(tx, "reorder.rule.upsert", "reorder_rule", r.rows[0].id, null, JSON.stringify({ branchId, variantId, reorderPoint, reorderQuantity }));
        return r.rows[0];
      },
    );
  }

  async listRules(claims: JwtPayloadClaims, branchId?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["r.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`r.branch_id = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT r.id, r.branch_id AS "branchId", r.variant_id AS "variantId",
                  r.reorder_point AS "reorderPoint", r.reorder_quantity AS "reorderQuantity",
                  r.lead_time_days AS "leadTimeDays", r.safety_stock_days AS "safetyStockDays",
                  r.demand_window_days AS "demandWindowDays", r.is_active AS "isActive",
                  r.created_at AS "createdAt", v.name AS "variantName", p.name AS "productName"
           FROM reorder_rules r
           JOIN product_variants v ON v.id = r.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY p.name, v.name LIMIT 500`,
          params,
        );
        return { rules: r.rows };
      },
    );
  }

  /** Trailing-window average daily demand per variant, plus days of cover. */
  async forecast(claims: JwtPayloadClaims, branchId: string, days = 30): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const windowDays = Math.min(Math.max(Math.trunc(days), 1), 365);
        const r = await tx.query(
          `WITH demand AS (
             SELECT sl.variant_id, COUNT(*)::int AS sale_count,
                    COALESCE(SUM(sl.quantity), 0)::numeric(14,4) AS units_sold
             FROM stock_ledger sl
             WHERE sl.org_id = $1 AND sl.branch_id = $2 AND sl.movement_type = 'sale'
               AND sl.business_time >= now() - make_interval(days => $3)
             GROUP BY sl.variant_id
           )
           SELECT v.id AS "variantId", v.name AS "variantName", p.name AS "productName",
                  COALESCE(d.sale_count, 0)::int AS "saleCount",
                  COALESCE(d.units_sold, 0)::numeric(14,4) AS "unitsSold",
                  ROUND((COALESCE(d.units_sold, 0) / $3)::numeric, 4) AS "avgDailyDemand",
                  COALESCE(ii.quantity_on_hand, 0)::numeric(14,4) AS "quantityOnHand",
                  CASE WHEN COALESCE(d.units_sold, 0) > 0
                       THEN ROUND((COALESCE(ii.quantity_on_hand, 0) / (COALESCE(d.units_sold, 0) / $3))::numeric, 2)
                       ELSE NULL END AS "daysOfCover"
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           LEFT JOIN demand d ON d.variant_id = v.id
           LEFT JOIN inventory_items ii
             ON ii.org_id = $1 AND ii.branch_id = $2 AND ii.variant_id = v.id
           WHERE v.org_id = $1
           ORDER BY p.name, v.name LIMIT 1000`,
          [claims.org, branchId, windowDays],
        );
        return { branchId, windowDays, forecast: r.rows };
      },
    );
  }

  /**
   * Regenerates the branch's open suggestions from rules (and variant-level
   * fallbacks). Explainable: each suggestion carries every input used and a
   * readable reason. Re-running refreshes open suggestions in place — a
   * converted or dismissed suggestion is never resurrected.
   */
  async evaluate(claims: JwtPayloadClaims, input: EvaluateInput): Promise<unknown> {
    const branchId = requireString(input.branchId, "branchId");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [branchId, claims.org]);
        if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

        // Drop stale open suggestions so the fresh set is authoritative.
        await tx.query("DELETE FROM reorder_suggestions WHERE org_id = $1 AND branch_id = $2 AND status = 'open'", [claims.org, branchId]);

        // Rules first (per-branch), then Phase 2 variant-level fallbacks.
        const rulesRes = await tx.query(
          `SELECT id, branch_id, variant_id, reorder_point, reorder_quantity, lead_time_days,
                  safety_stock_days, demand_window_days
           FROM reorder_rules
           WHERE org_id = $1 AND branch_id = $2 AND is_active
           ORDER BY created_at`,
          [claims.org, branchId],
        );
        const fallbacksRes = await tx.query(
          `SELECT id AS variant_id, $2::uuid AS branch_id, reorder_level AS reorder_point, reorder_quantity,
                  0 AS lead_time_days, 0 AS safety_stock_days, 30 AS demand_window_days
           FROM product_variants
           WHERE org_id = $1 AND reorder_level > 0 AND reorder_quantity > 0
             AND NOT EXISTS (
               SELECT 1 FROM reorder_rules r
               WHERE r.org_id = product_variants.org_id AND r.branch_id = $2 AND r.variant_id = product_variants.id
             )
           ORDER BY name`,
          [claims.org, branchId],
        );
        const rules = rulesRes.rows as RuleRow[];
        const fallbacks = fallbacksRes.rows as RuleRow[];

        const created: unknown[] = [];
        for (const rule of [...rules, ...fallbacks]) {
          const suggestion = await this.buildSuggestion(tx, claims.org, branchId, rule);
          if (!suggestion) continue;
          const inserted = await tx.query(
            `INSERT INTO reorder_suggestions
               (org_id, branch_id, variant_id, current_stock, reorder_point, avg_daily_demand,
                lead_time_days, safety_stock_days, days_of_cover, suggested_quantity, unit_cost,
                suggested_supplier_id, reason)
             VALUES ($1, $2, $3, $4::numeric(14,4), $5::numeric(14,4), $6::numeric(14,4),
                     $7, $8, $9::numeric(14,4), $10::numeric(14,4), $11::numeric(14,4), $12, $13)
             RETURNING id, variant_id AS "variantId", current_stock AS "currentStock",
                       reorder_point AS "reorderPoint", avg_daily_demand AS "avgDailyDemand",
                       days_of_cover AS "daysOfCover", suggested_quantity AS "suggestedQuantity",
                       unit_cost AS "unitCost", suggested_supplier_id AS "suggestedSupplierId",
                       reason, generated_at AS "generatedAt"`,
            [
              claims.org,
              branchId,
              rule.variant_id,
              suggestion.currentStock,
              suggestion.reorderPoint,
              suggestion.avgDailyDemand,
              suggestion.leadTimeDays,
              suggestion.safetyStockDays,
              suggestion.daysOfCover,
              suggestion.suggestedQuantity,
              suggestion.unitCost,
              suggestion.suggestedSupplierId,
              suggestion.reason,
            ],
          );
          created.push(inserted.rows[0]);
        }

        await this.audit.write(tx, "reorder.evaluate", "reorder_suggestion", null, null, JSON.stringify({ branchId, suggestions: created.length }));
        return { branchId, evaluatedAt: new Date().toISOString(), created: created.length, suggestions: created };
      },
    );
  }

  async listSuggestions(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["s.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`s.branch_id = $${params.length}`);
        }
        if (status === "open" || status === "converted" || status === "dismissed") {
          params.push(status);
          clauses.push(`s.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT s.id, s.branch_id AS "branchId", b.name AS "branchName", s.variant_id AS "variantId",
                  v.name AS "variantName", p.name AS "productName", s.status,
                  s.current_stock AS "currentStock", s.reorder_point AS "reorderPoint",
                  s.avg_daily_demand AS "avgDailyDemand", s.days_of_cover AS "daysOfCover",
                  s.suggested_quantity AS "suggestedQuantity", s.unit_cost AS "unitCost",
                  s.suggested_supplier_id AS "suggestedSupplierId", sup.name AS "supplierName",
                  s.reason, s.converted_po_id AS "convertedPoId", s.generated_at AS "generatedAt"
           FROM reorder_suggestions s
           JOIN branches b ON b.id = s.branch_id
           JOIN product_variants v ON v.id = s.variant_id
           JOIN products p ON p.id = v.product_id
           LEFT JOIN suppliers sup ON sup.id = s.suggested_supplier_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY s.generated_at DESC LIMIT 500`,
          params,
        );
        return { suggestions: r.rows };
      },
    );
  }

  async dismissSuggestion(claims: JwtPayloadClaims, suggestionId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `UPDATE reorder_suggestions SET status = 'dismissed'
           WHERE id = $1 AND org_id = $2 AND status = 'open'
           RETURNING id, variant_id AS "variantId", status`,
          [suggestionId, claims.org],
        );
        if (r.rows.length === 0) throw new NotFoundException("Open suggestion not found");
        await this.audit.write(tx, "reorder.suggestion.dismiss", "reorder_suggestion", suggestionId, null, null);
        return r.rows[0];
      },
    );
  }

  // ---- internals ------------------------------------------------------------

  private async assertBranchVariant(tx: DbExecutor, orgId: string, branchId: string, variantId: string): Promise<void> {
    const b = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [branchId, orgId]);
    if (b.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");
    const v = await tx.query("SELECT id FROM product_variants WHERE id = $1 AND org_id = $2", [variantId, orgId]);
    if (v.rows.length === 0) throw new BadRequestException("Unknown variant");
  }

  private async buildSuggestion(
    tx: DbExecutor,
    orgId: string,
    branchId: string,
    rule: RuleRow,
  ): Promise<{
    currentStock: string;
    reorderPoint: string;
    avgDailyDemand: string | null;
    leadTimeDays: number;
    safetyStockDays: number;
    daysOfCover: string | null;
    suggestedQuantity: string;
    unitCost: string | null;
    suggestedSupplierId: string | null;
    reason: string;
  } | null> {
    const stock = await tx.query(
      "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
      [orgId, branchId, rule.variant_id],
    );
    const currentStock = stock.rows.length ? (stock.rows[0].quantity_on_hand as string) : "0.0000";

    const onHand = Number(currentStock);
    const reorderPoint = Number(rule.reorder_point);
    if (onHand > reorderPoint) return null; // above the point — nothing to suggest

    const windowDays = Math.max(rule.demand_window_days, 1);
    const demandRes = await tx.query(
      `SELECT COUNT(*)::int AS sale_count, COALESCE(SUM(quantity), 0)::numeric(14,4) AS units_sold
       FROM stock_ledger
       WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3 AND movement_type = 'sale'
         AND business_time >= now() - make_interval(days => $4)`,
      [orgId, branchId, rule.variant_id, windowDays],
    );
    const demand = demandRes.rows[0] as DemandRow | undefined;
    const unitsSold = Number(demand?.units_sold ?? 0);
    const avgDailyDemand = unitsSold / windowDays;

    const supplier = await tx.query(
      `SELECT supplier_id, unit_cost FROM supplier_products
       WHERE org_id = $1 AND variant_id = $2
       ORDER BY is_default DESC, created_at LIMIT 1`,
      [orgId, rule.variant_id],
    );
    const suggestedSupplierId = supplier.rows.length ? (supplier.rows[0].supplier_id as string) : null;
    const unitCost = supplier.rows.length ? (supplier.rows[0].unit_cost as string) : null;

    const horizon = rule.lead_time_days + rule.safety_stock_days;
    let suggestedQuantity: number;
    if (avgDailyDemand > 0) {
      // Cover demand over lead time + safety, top up from what's on hand,
      // never below the configured reorder quantity.
      suggestedQuantity = Math.max(Number(rule.reorder_quantity), Math.ceil(avgDailyDemand * horizon - onHand));
    } else {
      suggestedQuantity = Number(rule.reorder_quantity);
    }
    if (suggestedQuantity <= 0) return null;

    const daysOfCover = avgDailyDemand > 0 ? onHand / avgDailyDemand : null;

    const demandBit =
      avgDailyDemand > 0
        ? `sales average ${avgDailyDemand.toFixed(4)}/day over the last ${windowDays}d (≈ ${daysOfCover?.toFixed(1) ?? "?"} days of cover)`
        : `no sales in the last ${windowDays}d`;
    const leadBit = horizon > 0 ? `; lead time ${rule.lead_time_days}d + ${rule.safety_stock_days}d safety` : "";
    const qtyBit =
      avgDailyDemand > 0
        ? `suggested ${suggestedQuantity.toFixed(4)} (reorder quantity ${rule.reorder_quantity})`
        : `suggested ${suggestedQuantity.toFixed(4)} (configured reorder quantity)`;
    const reason = `On hand ${currentStock} is at/below reorder point ${rule.reorder_point}; ${demandBit}${leadBit}. ${qtyBit}.`;

    return {
      currentStock: currentStock,
      reorderPoint: rule.reorder_point,
      avgDailyDemand: avgDailyDemand > 0 ? avgDailyDemand.toFixed(4) : null,
      leadTimeDays: rule.lead_time_days,
      safetyStockDays: rule.safety_stock_days,
      daysOfCover: daysOfCover !== null ? daysOfCover.toFixed(2) : null,
      suggestedQuantity: suggestedQuantity.toFixed(4),
      unitCost,
      suggestedSupplierId,
      reason,
    };
  }

  private intOr(value: number | undefined, fallback: number, name: string, opts?: { min?: number; max?: number }): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value)) throw new BadRequestException(`${name} must be an integer`);
    if (opts?.min !== undefined && value < opts.min) throw new BadRequestException(`${name} must be >= ${opts.min}`);
    if (opts?.max !== undefined && value > opts.max) throw new BadRequestException(`${name} must be <= ${opts.max}`);
    return value;
  }
}

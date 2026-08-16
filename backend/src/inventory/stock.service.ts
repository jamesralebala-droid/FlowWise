import { Inject, Injectable } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

@Injectable()
export class StockService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Per-branch balances (inventory_items, derived cache maintained by the ledger trigger). */
  async balances(claims: JwtPayloadClaims, branchId?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT branch_id AS "branchId", variant_id AS "variantId", variant_name AS "variantName",
                  product_id AS "productId", product_name AS "productName",
                  quantity_on_hand AS "quantityOnHand", last_movement_at AS "lastMovementAt"
           FROM v_inventory_balances
           WHERE ${clauses.join(" AND ")}
           ORDER BY product_name, variant_name LIMIT 1000`,
          params,
        );
        return { balances: r.rows };
      },
    );
  }

  /**
   * Per-branch batch balances. The batch metadata lives at its origin branch;
   * the balance is the ledger sum AT THE GIVEN BRANCH (transferred-in stock
   * shows up under the receiving branch), so every batch the branch has ever
   * received or sent is listed with its current on-hand.
   */
  async batches(claims: JwtPayloadClaims, branchId: string, variantId?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const params: unknown[] = [branchId, claims.org];
        let variantClause = "";
        if (variantId) {
          params.push(variantId);
          variantClause = `AND b.variant_id = $${params.length}`;
        }
        const r = await tx.query(
          `SELECT b.id, b.batch_no AS "batchNo", b.expiry_date AS "expiryDate",
                  b.unit_cost AS "unitCost", b.variant_id AS "variantId", v.name AS "variantName",
                  COALESCE(SUM(sl.quantity), 0)::numeric(14,4) AS "quantityOnHand"
           FROM batches b
           JOIN stock_ledger sl ON sl.batch_id = b.id AND sl.branch_id = $1
           JOIN product_variants v ON v.id = b.variant_id
           WHERE b.org_id = $2 ${variantClause}
           GROUP BY b.id, v.name
           ORDER BY b.expiry_date NULLS LAST, b.created_at
           LIMIT 1000`,
          params,
        );
        return { batches: r.rows };
      },
    );
  }

  /** Low-stock alerts: configured variants at or below their reorder level. */
  async lowStock(claims: JwtPayloadClaims, branchId?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["ii.org_id = $1", "(v.reorder_level > 0 OR v.reorder_quantity > 0)", "ii.quantity_on_hand <= v.reorder_level"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`ii.branch_id = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT ii.branch_id AS "branchId", ii.variant_id AS "variantId", v.name AS "variantName",
                  p.name AS "productName", ii.quantity_on_hand AS "quantityOnHand",
                  v.reorder_level AS "reorderLevel", v.reorder_quantity AS "reorderQuantity",
                  GREATEST(v.reorder_level - ii.quantity_on_hand, 0)::numeric(14,4) AS "shortage"
           FROM inventory_items ii
           JOIN product_variants v ON v.id = ii.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY shortage DESC, v.name
           LIMIT 500`,
          params,
        );
        return { lowStock: r.rows };
      },
    );
  }

  /** Append-only ledger feed (audit / traceability). */
  async ledger(claims: JwtPayloadClaims, branchId?: string, since?: string, limit = 200): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        if (since) {
          params.push(since);
          clauses.push(`business_time > $${params.length}`);
        }
        const safeLimit = Math.min(Math.max(limit, 1), 1000);
        params.push(safeLimit);
        const r = await tx.query(
          `SELECT id, branch_id AS "branchId", branch_name AS "branchName", variant_id AS "variantId",
                  variant_name AS "variantName", product_name AS "productName", movement_type AS "movementType",
                  quantity, unit_cost AS "unitCost", reference_type AS "referenceType", reference_id AS "referenceId",
                  idempotency_key AS "idempotencyKey", business_time AS "businessTime"
           FROM v_stock_ledger_full
           WHERE ${clauses.join(" AND ")}
           ORDER BY business_time DESC LIMIT $${params.length}`,
          params,
        );
        return { ledger: r.rows };
      },
    );
  }
}

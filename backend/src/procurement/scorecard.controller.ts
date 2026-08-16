import { Controller, Get, Req } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";

/**
 * Supplier scorecard — derived view over POs + linked GRNs (never stored):
 * PO count, fully-received count, ordered vs received value, average lead
 * time, and on-time rate vs the PO's expected delivery date.
 *
 * Registered BEFORE SuppliersController so GET /v1/suppliers/scorecard wins
 * the route match over GET /v1/suppliers/:id.
 */
@Controller("suppliers/scorecard")
export class ScorecardController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @Permissions("purchase.po")
  async scorecard(@Req() req: AuthedRequest) {
    return this.db.withContext(
      { orgId: req.claims.org, userId: req.claims.sub, deviceId: req.claims.dev },
      async (tx) => {
        const r = await tx.query(
          `SELECT supplier_id AS "supplierId", supplier_name AS "supplierName", supplier_code AS "supplierCode",
                  po_count AS "poCount", fully_received_count AS "fullyReceivedCount",
                  partially_or_fully_received_count AS "partiallyOrFullyReceivedCount",
                  total_ordered_value AS "totalOrderedValue", total_received_value AS "totalReceivedValue",
                  avg_lead_time_days AS "avgLeadTimeDays", on_time_rate AS "onTimeRate"
           FROM v_supplier_scorecard
           WHERE supplier_id IN (SELECT id FROM suppliers WHERE org_id = $1)
           ORDER BY supplier_name`,
          [req.claims.org],
        );
        return { scorecard: r.rows };
      },
    );
  }
}

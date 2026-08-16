import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDate, assertDecimal, requireString } from "../inventory/validate.js";
import { poEventPayload, WebhooksService } from "./webhooks.service.js";

export interface PoLineInput {
  variantId: string;
  /** decimal STRING */
  quantity: string;
  /** decimal STRING — optional; falls back to the supplier mapping */
  unitCost?: string;
}

export interface CreatePoInput {
  clientOperationId: string;
  branchId?: string;
  supplierId?: string;
  expectedDelivery?: string;
  notes?: string;
  /** Convert an open reorder suggestion into this PO (one line). */
  suggestionId?: string;
  /** Alternative to suggestionId: explicit lines. */
  lines?: PoLineInput[];
}

const PO_COLS = `id, branch_id AS "branchId", supplier_id AS "supplierId", document_no AS "documentNo",
  status, client_operation_id AS "clientOperationId", expected_delivery AS "expectedDelivery", notes,
  created_by_user_id AS "createdByUserId", created_by_device_id AS "createdByDeviceId",
  sent_at AS "sentAt", created_at AS "createdAt"`;

function docNo(): string {
  return `PO-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

/**
 * Phase 3 — purchase orders. Lifecycle: draft → sent → partially_received →
 * received (or draft → cancelled). Receipts happen THROUGH the GRN path
 * (`poId` on the GRN), so the ledger movement and the PO received-quantity
 * update commit in one transaction (Invariant 3). A sent PO is immutable
 * except for receipt-progress status changes (DB trigger).
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * Creates a draft PO either from an open reorder suggestion (the Phase 3
   * exit flow) or from explicit lines. Replaying clientOperationId returns
   * the stored PO with zero side effects (Invariant 4).
   */
  async create(claims: JwtPayloadClaims, input: CreatePoInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id FROM purchase_orders WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) return this.load(tx, claims.org, existing.rows[0].id as string);
        return this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
      },
    );
  }

  /**
   * Sends a draft PO: status → sent (snapshot moment). Idempotent — sending
   * an already-sent PO returns the stored document. Emits a `po.sent`
   * webhook event (delivered after the transaction commits).
   */
  async send(claims: JwtPayloadClaims, poId: string): Promise<unknown> {
    const po = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query(`SELECT ${PO_COLS} FROM purchase_orders WHERE id = $1 AND org_id = $2`, [poId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Purchase order not found");
        const row = existing.rows[0] as { status: string };
        if (row.status === "cancelled") throw new BadRequestException("Cannot send a cancelled purchase order");
        if (row.status !== "draft") return this.load(tx, claims.org, poId);

        const updated = await tx.query(
          `UPDATE purchase_orders SET status = 'sent', sent_at = now()
           WHERE id = $1 AND org_id = $2 AND status = 'draft'
           RETURNING ${PO_COLS}`,
          [poId, claims.org],
        );
        await this.audit.write(tx, "po.send", "purchase_order", poId, null, JSON.stringify({ documentNo: updated.rows[0].documentNo }));
        await this.webhooks.enqueue(tx, claims.org, "po.sent", poEventPayload(claims.org, updated.rows[0]));
        return this.load(tx, claims.org, poId);
      },
    );
    await this.webhooks.deliverDue(claims.org);
    return po;
  }

  /** Cancels a draft PO (cancelled is terminal; a sent PO cannot be cancelled). */
  async cancel(claims: JwtPayloadClaims, poId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query(`SELECT ${PO_COLS} FROM purchase_orders WHERE id = $1 AND org_id = $2`, [poId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Purchase order not found");
        const row = existing.rows[0] as { status: string; documentNo: string };
        if (row.status === "cancelled") return this.load(tx, claims.org, poId);
        if (row.status !== "draft") throw new BadRequestException("Only draft purchase orders can be cancelled");

        await tx.query(
          `UPDATE purchase_orders SET status = 'cancelled'
           WHERE id = $1 AND org_id = $2 AND status = 'draft'`,
          [poId, claims.org],
        );
        await this.audit.write(tx, "po.cancel", "purchase_order", poId, null, JSON.stringify({ documentNo: row.documentNo }));
        return this.load(tx, claims.org, poId);
      },
    );
  }

  async get(claims: JwtPayloadClaims, poId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.load(tx, claims.org, poId),
    );
  }

  async list(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["po.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`po.branch_id = $${params.length}`);
        }
        const knownStatuses = ["draft", "sent", "partially_received", "received", "cancelled"];
        if (status && knownStatuses.includes(status)) {
          params.push(status);
          clauses.push(`po.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT po.id, po.branch_id AS "branchId", b.name AS "branchName",
                  po.supplier_id AS "supplierId", s.name AS "supplierName",
                  po.document_no AS "documentNo", po.status, po.expected_delivery AS "expectedDelivery",
                  po.sent_at AS "sentAt", po.created_at AS "createdAt",
                  COUNT(pl.id)::int AS "lineCount",
                  COALESCE(SUM(pl.quantity), 0)::numeric(14,4) AS "totalQuantity",
                  COALESCE(SUM(pl.received_quantity), 0)::numeric(14,4) AS "receivedQuantity"
           FROM purchase_orders po
           JOIN branches b ON b.id = po.branch_id
           JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN purchase_order_lines pl ON pl.purchase_order_id = po.id
           WHERE ${clauses.join(" AND ")}
           GROUP BY po.id, b.name, s.name
           ORDER BY po.created_at DESC LIMIT 200`,
          params,
        );
        return { purchaseOrders: r.rows };
      },
    );
  }

  // ---- internals ------------------------------------------------------------

  private async insertDraft(tx: DbExecutor, claims: JwtPayloadClaims, input: CreatePoInput): Promise<unknown> {
    let branchId = input.branchId;
    let supplierId = input.supplierId;
    let lines: { variantId: string; quantity: string; unitCost: string | null }[];

    if (input.suggestionId) {
      const s = await tx.query(
        `SELECT id, branch_id, variant_id, suggested_quantity, unit_cost, suggested_supplier_id
         FROM reorder_suggestions
         WHERE id = $1 AND org_id = $2 AND status = 'open'`,
        [input.suggestionId, claims.org],
      );
      if (s.rows.length === 0) throw new BadRequestException("Open suggestion not found");
      const suggestion = s.rows[0] as {
        branch_id: string;
        variant_id: string;
        suggested_quantity: string;
        unit_cost: string | null;
        suggested_supplier_id: string | null;
      };
      if (branchId && branchId !== suggestion.branch_id) {
        throw new BadRequestException("branchId does not match the suggestion's branch");
      }
      branchId = suggestion.branch_id;
      supplierId = supplierId ?? suggestion.suggested_supplier_id ?? undefined;
      lines = [{ variantId: suggestion.variant_id, quantity: suggestion.suggested_quantity, unitCost: suggestion.unit_cost }];
      if (!supplierId) throw new BadRequestException("No supplier is mapped to this variant — map one or pass supplierId");
    } else {
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new BadRequestException("a purchase order needs either suggestionId or lines");
      }
      if (!supplierId) throw new BadRequestException("supplierId is required");
      lines = [];
      for (const [i, l] of input.lines.entries()) {
        const unitCost = l.unitCost !== undefined && l.unitCost !== null
          ? assertDecimal(l.unitCost, `lines[${i}].unitCost`, { allowZero: true })
          : null;
        lines.push({
          variantId: requireString(l.variantId, `lines[${i}].variantId`),
          quantity: assertDecimal(l.quantity, `lines[${i}].quantity`, { allowZero: false }),
          unitCost,
        });
      }
    }

    const branchIdOut = requireString(branchId, "branchId");
    const supplierIdOut = requireString(supplierId, "supplierId");

    const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [branchIdOut, claims.org]);
    if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");
    const supplier = await tx.query("SELECT id FROM suppliers WHERE id = $1 AND org_id = $2 AND is_active", [supplierIdOut, claims.org]);
    if (supplier.rows.length === 0) throw new BadRequestException("Unknown or inactive supplier");

    // Resolve missing unit costs from the supplier's product mappings.
    for (const [i, line] of lines.entries()) {
      const v = await tx.query("SELECT id FROM product_variants WHERE id = $1 AND org_id = $2", [line.variantId, claims.org]);
      if (v.rows.length === 0) throw new BadRequestException(`lines[${i}].variantId: unknown variant`);
      if (!line.unitCost) {
        const m = await tx.query(
          "SELECT unit_cost FROM supplier_products WHERE org_id = $1 AND supplier_id = $2 AND variant_id = $3",
          [claims.org, supplierIdOut, line.variantId],
        );
        if (m.rows.length === 0 || m.rows[0].unit_cost === null) {
          throw new BadRequestException(`lines[${i}].variantId: no unit cost — pass unitCost or map it on the supplier`);
        }
        line.unitCost = m.rows[0].unit_cost as string;
      }
    }

    let po;
    try {
      const r = await tx.query(
        `INSERT INTO purchase_orders
           (org_id, branch_id, supplier_id, document_no, client_operation_id, expected_delivery, notes,
            created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9)
         RETURNING ${PO_COLS}`,
        [claims.org, branchIdOut, supplierIdOut, docNo(), input.clientOperationId, assertDate(input.expectedDelivery, "expectedDelivery"), input.notes ?? null, claims.sub, claims.dev ?? null],
      );
      po = r.rows[0];
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictException("A purchase order with this clientOperationId already exists");
      }
      throw err;
    }

    for (const [i, line] of lines.entries()) {
      await tx.query(
        `INSERT INTO purchase_order_lines (org_id, purchase_order_id, line_no, variant_id, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6::numeric(14,4))`,
        [claims.org, po.id, i + 1, line.variantId, line.quantity, line.unitCost],
      );
    }

    if (input.suggestionId) {
      const converted = await tx.query(
        `UPDATE reorder_suggestions SET status = 'converted', converted_po_id = $1
         WHERE id = $2 AND org_id = $3 AND status = 'open'`,
        [po.id, input.suggestionId, claims.org],
      );
      if (converted.rowCount !== 1) throw new ConflictException("Suggestion was converted or dismissed while creating the PO");
    }

    await this.audit.write(tx, "po.create", "purchase_order", po.id, null, JSON.stringify({ documentNo: po.documentNo, lines: lines.length }));
    return this.load(tx, claims.org, po.id as string);
  }

  private async load(tx: DbExecutor, orgId: string, poId: string): Promise<unknown> {
    const po = await tx.query(
      `SELECT po.id, po.branch_id AS "branchId", po.supplier_id AS "supplierId",
              po.document_no AS "documentNo", po.status,
              po.client_operation_id AS "clientOperationId",
              po.expected_delivery AS "expectedDelivery", po.notes,
              po.created_by_user_id AS "createdByUserId", po.created_by_device_id AS "createdByDeviceId",
              po.sent_at AS "sentAt", po.created_at AS "createdAt",
              s.name AS "supplierName", b.name AS "branchName"
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN branches b ON b.id = po.branch_id
       WHERE po.id = $1 AND po.org_id = $2`,
      [poId, orgId],
    );
    if (po.rows.length === 0) throw new NotFoundException("Purchase order not found");
    const lines = await tx.query(
      `SELECT pl.id, pl.line_no AS "lineNo", pl.variant_id AS "variantId", v.name AS "variantName",
              p.name AS "productName", pl.quantity, pl.unit_cost AS "unitCost",
              pl.received_quantity AS "receivedQuantity",
              (pl.quantity - pl.received_quantity)::numeric(14,4) AS "outstandingQuantity"
       FROM purchase_order_lines pl
       JOIN product_variants v ON v.id = pl.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE pl.purchase_order_id = $1 AND pl.org_id = $2
       ORDER BY pl.line_no`,
      [poId, orgId],
    );
    return { ...po.rows[0], lines: lines.rows };
  }
}

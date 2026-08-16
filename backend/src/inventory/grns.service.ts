import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDate, assertDecimal, requireString } from "./validate.js";
import { poEventPayload, WebhooksService } from "../procurement/webhooks.service.js";

export interface GrnLineInput {
  variantId: string;
  /** decimal STRING */
  quantity: string;
  /** decimal STRING — landed unit cost */
  unitCost: string;
  batchNo?: string;
  expiryDate?: string;
}

export interface CreateGrnInput {
  clientOperationId: string;
  branchId: string;
  supplierId?: string;
  /** Optional: receive against a SENT purchase order (partial receipts). */
  poId?: string;
  notes?: string;
  lines: GrnLineInput[];
}

const GRN_COLS = `id, branch_id AS "branchId", supplier_id AS "supplierId", po_id AS "poId",
  document_no AS "documentNo", status, client_operation_id AS "clientOperationId", received_at AS "receivedAt", notes,
  created_by_user_id AS "createdByUserId", created_by_device_id AS "createdByDeviceId",
  posted_at AS "postedAt", created_at AS "createdAt"`;

function docNo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

@Injectable()
export class GrnsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
  ) {}

  /** Creates a draft GRN. Replaying the same clientOperationId returns the draft. */
  async create(claims: JwtPayloadClaims, input: CreateGrnInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateLines(input.lines);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id FROM goods_receipts WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) return this.load(tx, claims.org, existing.rows[0].id as string);
        return this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
      },
    );
  }

  /**
   * Posts a draft: batch metadata upsert + stock_ledger movements + status
   * transition in ONE transaction (Invariant 3). Replay-safe: posting an
   * already-posted GRN returns the stored document (idempotent).
   */
  async post(claims: JwtPayloadClaims, grnId: string): Promise<unknown> {
    const grn = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM goods_receipts WHERE id = $1 AND org_id = $2", [grnId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("GRN not found");
        if (existing.rows[0].status === "posted") return this.load(tx, claims.org, grnId);
        return this.postDraft(tx, claims, grnId);
      },
    );
    // PO receipt events enqueued inside the tx are delivered after commit.
    await this.webhooks.deliverDue(claims.org);
    return grn;
  }

  /**
   * Single-transaction create+post — the offline outbox path. The whole
   * document lands with its ledger rows together or not at all (Invariant 3).
   */
  async createAndPost(claims: JwtPayloadClaims, input: CreateGrnInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateLines(input.lines);

    const grn = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM goods_receipts WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].status === "posted") return this.load(tx, claims.org, existing.rows[0].id as string);
          return this.postDraft(tx, claims, existing.rows[0].id as string);
        }
        const draft = await this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
        return this.postDraft(tx, claims, (draft as { id: string }).id);
      },
    );
    await this.webhooks.deliverDue(claims.org);
    return grn;
  }

  async get(claims: JwtPayloadClaims, grnId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.load(tx, claims.org, grnId),
    );
  }

  async list(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["g.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`g.branch_id = $${params.length}`);
        }
        if (status === "draft" || status === "posted") {
          params.push(status);
          clauses.push(`g.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT g.id, g.branch_id AS "branchId", g.supplier_id AS "supplierId", s.name AS "supplierName",
                  g.document_no AS "documentNo", g.status, g.received_at AS "receivedAt",
                  g.posted_at AS "postedAt", g.created_at AS "createdAt",
                  COUNT(l.id)::int AS "lineCount",
                  COALESCE(SUM(l.quantity), 0)::numeric(14,4) AS "totalQuantity"
           FROM goods_receipts g
           LEFT JOIN suppliers s ON s.id = g.supplier_id
           LEFT JOIN goods_receipt_lines l ON l.goods_receipt_id = g.id
           WHERE ${clauses.join(" AND ")}
           GROUP BY g.id, s.name
           ORDER BY g.received_at DESC LIMIT 200`,
          params,
        );
        return { grns: r.rows };
      },
    );
  }

  // ---- internals -------------------------------------------------------------

  private validateLines(lines: GrnLineInput[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestException("a GRN needs at least one line");
    }
    for (const [i, l] of lines.entries()) {
      requireString(l.variantId, `lines[${i}].variantId`);
      assertDecimal(l.quantity, `lines[${i}].quantity`, { allowZero: false });
      assertDecimal(l.unitCost, `lines[${i}].unitCost`, { allowZero: true });
      assertDate(l.expiryDate, `lines[${i}].expiryDate`);
    }
  }

  private async insertDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    input: CreateGrnInput,
  ): Promise<unknown> {
    const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [input.branchId, claims.org]);
    if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

    if (input.supplierId) {
      const sup = await tx.query("SELECT id FROM suppliers WHERE id = $1 AND org_id = $2 AND is_active", [input.supplierId, claims.org]);
      if (sup.rows.length === 0) throw new BadRequestException("Unknown or inactive supplier");
    }

    // Optional PO receipt: the PO must exist in this org, belong to the same
    // branch, and be sendable (sent/partially_received). The DB trigger
    // assert_po_receipt_within_ordered additionally caps each line at the
    // ordered quantity (partial receipts, never overshoot).
    let poId: string | null = null;
    if (input.poId) {
      poId = requireString(input.poId, "poId");
      const po = await tx.query(
        "SELECT id, branch_id, status FROM purchase_orders WHERE id = $1 AND org_id = $2",
        [poId, claims.org],
      );
      if (po.rows.length === 0) throw new BadRequestException("Unknown purchase order");
      const poRow = po.rows[0] as { branch_id: string; status: string };
      if (poRow.branch_id !== input.branchId) {
        throw new BadRequestException("GRN branch must match the purchase order branch");
      }
      if (poRow.status !== "sent" && poRow.status !== "partially_received") {
        throw new BadRequestException("Only a sent purchase order can be received");
      }
      // Service-level cap check for a clean 400 (the DB trigger stays as the
      // backstop — a receipt never exceeds what was ordered, ever).
      for (const [i, line] of input.lines.entries()) {
        const pl = await tx.query(
          `SELECT quantity, received_quantity FROM purchase_order_lines
           WHERE purchase_order_id = $1 AND variant_id = $2 AND org_id = $3`,
          [poId, line.variantId, claims.org],
        );
        if (pl.rows.length === 0) throw new BadRequestException(`lines[${i}].variantId: not a line on this purchase order`);
        const remaining = Number(pl.rows[0].quantity) - Number(pl.rows[0].received_quantity);
        if (Number(line.quantity) > remaining) {
          throw new BadRequestException(
            `Receipt of ${line.quantity} exceeds the ${pl.rows[0].quantity} ordered (${pl.rows[0].received_quantity} already received)`,
          );
        }
      }
    }

    let grn;
    try {
      const r = await tx.query(
        `INSERT INTO goods_receipts (org_id, branch_id, supplier_id, document_no, client_operation_id, po_id, notes,
                                     created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${GRN_COLS}`,
        [claims.org, input.branchId, input.supplierId ?? null, docNo("GRN"), input.clientOperationId, poId, input.notes ?? null, claims.sub, claims.dev ?? null],
      );
      grn = r.rows[0];
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictException("A GRN with this clientOperationId already exists");
      }
      throw err;
    }

    for (const [i, l] of input.lines.entries()) {
      await tx.query(
        `INSERT INTO goods_receipt_lines (org_id, goods_receipt_id, line_no, variant_id, quantity, unit_cost, batch_no, expiry_date)
         VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6::numeric(14,4), $7, $8::date)`,
        [claims.org, grn.id, i + 1, l.variantId, l.quantity, l.unitCost, l.batchNo ?? null, assertDate(l.expiryDate, "expiryDate")],
      );
    }

    await this.audit.write(tx, "grn.create", "goods_receipt", grn.id, null, JSON.stringify({ documentNo: grn.documentNo, lines: input.lines.length }));
    return this.load(tx, claims.org, grn.id as string);
  }

  private async postDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    grnId: string,
  ): Promise<unknown> {
    const grn = await tx.query("SELECT * FROM goods_receipts WHERE id = $1 AND org_id = $2 AND status = 'draft'", [grnId, claims.org]);
    if (grn.rows.length === 0) throw new NotFoundException("GRN not found or not draft");

    const lines = await tx.query(
      "SELECT line_no, variant_id, quantity, unit_cost, batch_no, expiry_date FROM goods_receipt_lines WHERE goods_receipt_id = $1 ORDER BY line_no",
      [grnId],
    );
    if (lines.rows.length === 0) throw new BadRequestException("Cannot post a GRN with no lines");

    for (const line of lines.rows) {
      // Upsert the batch (metadata only). Split deliveries of the same
      // batch_no re-use the row — quantity accumulates via the ledger.
      let batchId: string | null = null;
      if (line.batch_no) {
        const b = await tx.query(
          `WITH ins AS (
             INSERT INTO batches (org_id, branch_id, variant_id, batch_no, expiry_date, unit_cost, source_grn_id)
             VALUES ($1, $2, $3, $4, $5::date, $6::numeric(14,4), $7)
             ON CONFLICT (org_id, branch_id, variant_id, batch_no) DO NOTHING
             RETURNING id
           )
           SELECT id FROM ins
           UNION ALL
           SELECT id FROM batches WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3 AND batch_no = $4
           LIMIT 1`,
          [claims.org, grn.rows[0].branch_id, line.variant_id, line.batch_no, line.expiry_date, line.unit_cost, grnId],
        );
        batchId = b.rows[0].id as string;
      }

      await tx.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
            reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id, notes)
         VALUES ($1, $2, $3, 'grn', $4::numeric(14,4), $5::numeric(14,4), $6,
                 'grn', $7, 'grn:' || $8 || ':' || $9, now(), $10, $11, $12)`,
        [
          claims.org,
          grn.rows[0].branch_id,
          line.variant_id,
          line.quantity,
          line.unit_cost,
          batchId,
          grnId,
          grn.rows[0].client_operation_id,
          line.line_no,
          claims.sub,
          claims.dev ?? null,
          line.batch_no ? `batch ${line.batch_no}` : null,
        ],
      );
    }

    const r = await tx.query(
      `UPDATE goods_receipts SET status = 'posted', posted_at = now() WHERE id = $1 AND org_id = $2 RETURNING ${GRN_COLS}`,
      [grnId, claims.org],
    );

    // Receipt against a PO: ledger rows (above) and the PO received-quantity
    // update commit in the SAME transaction (Invariant 3), then the PO's
    // status is recomputed and events enqueued for the webhook dispatcher.
    if (grn.rows[0].po_id) {
      await this.applyPoReceipt(tx, claims.org, grnId);
    }

    await this.audit.write(tx, "grn.post", "goods_receipt", grnId, null, JSON.stringify({ documentNo: grn.rows[0].document_no, lines: lines.rows.length }));
    return this.load(tx, claims.org, grnId);
  }

  /**
   * Applies a posted GRN to its purchase order: accumulates received_quantity
   * per line and recomputes the PO status (sent → partially_received →
   * received). Both the ledger movement and this update already happened in
   * the caller's transaction, so a replayed GRN can never double-count.
   */
  private async applyPoReceipt(tx: DbExecutor, orgId: string, grnId: string): Promise<void> {
    const grn = await tx.query("SELECT po_id, document_no FROM goods_receipts WHERE id = $1 AND org_id = $2", [grnId, orgId]);
    const poId = grn.rows[0].po_id as string;
    const lines = await tx.query(
      "SELECT variant_id, quantity FROM goods_receipt_lines WHERE goods_receipt_id = $1 AND org_id = $2",
      [grnId, orgId],
    );

    for (const line of lines.rows) {
      const updated = await tx.query(
        `UPDATE purchase_order_lines
         SET received_quantity = received_quantity + $3::numeric(14,4)
         WHERE purchase_order_id = $1 AND variant_id = $2 AND org_id = $4
         RETURNING id`,
        [poId, line.variant_id, line.quantity, orgId],
      );
      if (updated.rows.length === 0) {
        // assert_po_receipt_within_ordered already guards this at insert time;
        // this is a defensive second line against a concurrent edit.
        throw new BadRequestException("GRN line is not on the purchase order");
      }
    }

    const all = await tx.query(
      "SELECT quantity, received_quantity FROM purchase_order_lines WHERE purchase_order_id = $1 AND org_id = $2",
      [poId, orgId],
    );
    const fully = all.rows.every((l) => Number(l.received_quantity) >= Number(l.quantity));
    const anyReceived = all.rows.some((l) => Number(l.received_quantity) > 0);
    const status = fully ? "received" : anyReceived ? "partially_received" : "sent";

    await tx.query("UPDATE purchase_orders SET status = $3 WHERE id = $1 AND org_id = $2", [poId, orgId, status]);

    const po = await tx.query(
      `SELECT id, branch_id AS "branchId", supplier_id AS "supplierId", document_no AS "documentNo",
              status, expected_delivery AS "expectedDelivery"
       FROM purchase_orders WHERE id = $1 AND org_id = $2`,
      [poId, orgId],
    );
    await this.webhooks.enqueue(
      tx,
      orgId,
      fully ? "po.received" : "po.partially_received",
      poEventPayload(orgId, po.rows[0] as Record<string, any> as any),
    );
  }

  private async load(
    tx: DbExecutor,
    orgId: string,
    grnId: string,
  ): Promise<unknown> {
    const g = await tx.query(`SELECT ${GRN_COLS} FROM goods_receipts WHERE id = $1 AND org_id = $2`, [grnId, orgId]);
    if (g.rows.length === 0) throw new NotFoundException("GRN not found");
    const lines = await tx.query(
      `SELECT gl.id, gl.line_no AS "lineNo", gl.variant_id AS "variantId", gl.quantity, gl.unit_cost AS "unitCost",
              gl.batch_no AS "batchNo", gl.expiry_date AS "expiryDate", b.id AS "batchId"
       FROM goods_receipt_lines gl
       JOIN goods_receipts g ON g.id = gl.goods_receipt_id
       LEFT JOIN batches b ON b.org_id = gl.org_id AND b.branch_id = g.branch_id
                           AND b.variant_id = gl.variant_id AND b.batch_no = gl.batch_no
       WHERE gl.goods_receipt_id = $1 AND gl.org_id = $2
       ORDER BY gl.line_no`,
      [grnId, orgId],
    );
    return { ...g.rows[0], lines: lines.rows };
  }
}

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDecimal, requireString } from "./validate.js";

export type AdjustmentType = "increase" | "decrease";

export interface AdjustmentLineInput {
  variantId: string;
  /** decimal STRING — positive, signed by adjustmentType at post time */
  quantity: string;
  unitCost?: string;
  batchId?: string;
}

export interface CreateAdjustmentInput {
  clientOperationId: string;
  branchId: string;
  adjustmentType: AdjustmentType;
  reason: string;
  notes?: string;
  lines: AdjustmentLineInput[];
}

const ADJUSTMENT_COLS = `id, branch_id AS "branchId", document_no AS "documentNo", status,
  adjustment_type AS "adjustmentType", reason, client_operation_id AS "clientOperationId", notes,
  created_by_user_id AS "createdByUserId", created_by_device_id AS "createdByDeviceId",
  posted_at AS "postedAt", created_at AS "createdAt"`;

function docNo(): string {
  return `ADJ-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Creates a draft adjustment. Replaying the same clientOperationId returns the draft. */
  async create(claims: JwtPayloadClaims, input: CreateAdjustmentInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateInput(input);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id FROM stock_adjustments WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) return this.load(tx, claims.org, existing.rows[0].id as string);
        return this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
      },
    );
  }

  /**
   * Posts the adjustment: signed ledger movements (increase + / decrease -)
   * in ONE transaction (Invariant 3). Decreases are validated against on-hand
   * so a bad adjustment can never push stock negative (oversell resolution).
   * Requires stock.adjust.approve. Replay-safe.
   */
  async post(claims: JwtPayloadClaims, adjustmentId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM stock_adjustments WHERE id = $1 AND org_id = $2", [adjustmentId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Adjustment not found");
        if (existing.rows[0].status === "posted") return this.load(tx, claims.org, adjustmentId);
        return this.postDraft(tx, claims, adjustmentId);
      },
    );
  }

  /** Single-transaction create+post — the offline outbox path (Invariant 3). */
  async createAndPost(claims: JwtPayloadClaims, input: CreateAdjustmentInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateInput(input);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM stock_adjustments WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].status === "posted") return this.load(tx, claims.org, existing.rows[0].id as string);
          return this.postDraft(tx, claims, existing.rows[0].id as string);
        }
        const draft = await this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
        return this.postDraft(tx, claims, (draft as { id: string }).id);
      },
    );
  }

  async get(claims: JwtPayloadClaims, adjustmentId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.load(tx, claims.org, adjustmentId),
    );
  }

  async list(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["a.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`a.branch_id = $${params.length}`);
        }
        if (status === "draft" || status === "posted") {
          params.push(status);
          clauses.push(`a.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT a.id, a.branch_id AS "branchId", a.document_no AS "documentNo", a.status,
                  a.adjustment_type AS "adjustmentType", a.reason, a.posted_at AS "postedAt", a.created_at AS "createdAt",
                  COUNT(l.id)::int AS "lineCount",
                  COALESCE(SUM(l.quantity), 0)::numeric(14,4) AS "totalQuantity"
           FROM stock_adjustments a
           LEFT JOIN stock_adjustment_lines l ON l.adjustment_id = a.id
           WHERE ${clauses.join(" AND ")}
           GROUP BY a.id
           ORDER BY a.created_at DESC LIMIT 200`,
          params,
        );
        return { adjustments: r.rows };
      },
    );
  }

  // ---- internals -------------------------------------------------------------

  private validateInput(input: CreateAdjustmentInput): void {
    if (input.adjustmentType !== "increase" && input.adjustmentType !== "decrease") {
      throw new BadRequestException("adjustmentType must be 'increase' or 'decrease'");
    }
    requireString(input.reason, "reason");
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new BadRequestException("an adjustment needs at least one line");
    }
    for (const [i, l] of input.lines.entries()) {
      requireString(l.variantId, `lines[${i}].variantId`);
      assertDecimal(l.quantity, `lines[${i}].quantity`, { allowZero: false });
      if (l.unitCost !== undefined && l.unitCost !== null) {
        assertDecimal(l.unitCost, `lines[${i}].unitCost`, { allowZero: true });
      }
      if (l.batchId !== undefined && l.batchId !== null && typeof l.batchId !== "string") {
        throw new BadRequestException(`lines[${i}].batchId must be a string`);
      }
    }
  }

  private async insertDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    input: CreateAdjustmentInput,
  ): Promise<unknown> {
    const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [input.branchId, claims.org]);
    if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

    for (const [i, l] of input.lines.entries()) {
      const v = await tx.query("SELECT id FROM product_variants WHERE id = $1 AND org_id = $2 AND is_active", [l.variantId, claims.org]);
      if (v.rows.length === 0) throw new BadRequestException(`lines[${i}].variantId is unknown or inactive`);
      if (l.batchId) {
        const b = await tx.query(
          "SELECT id FROM batches WHERE id = $1 AND org_id = $2 AND variant_id = $3 AND branch_id = $4",
          [l.batchId, claims.org, l.variantId, input.branchId],
        );
        if (b.rows.length === 0) throw new BadRequestException(`lines[${i}].batchId does not exist at this branch`);
      }
    }

    let adjustment;
    try {
      const r = await tx.query(
        `INSERT INTO stock_adjustments (org_id, branch_id, document_no, adjustment_type, reason, client_operation_id, notes,
                                        created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${ADJUSTMENT_COLS}`,
        [claims.org, input.branchId, docNo(), input.adjustmentType, input.reason, input.clientOperationId, input.notes ?? null, claims.sub, claims.dev ?? null],
      );
      adjustment = r.rows[0];
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictException("An adjustment with this clientOperationId already exists");
      }
      throw err;
    }

    for (const [i, l] of input.lines.entries()) {
      await tx.query(
        `INSERT INTO stock_adjustment_lines (org_id, adjustment_id, line_no, variant_id, quantity, unit_cost, batch_id)
         VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6::numeric(14,4), $7)`,
        [claims.org, adjustment.id, i + 1, l.variantId, l.quantity, l.unitCost ?? null, l.batchId ?? null],
      );
    }

    await this.audit.write(tx, "adjustment.create", "stock_adjustment", adjustment.id, null, JSON.stringify({ documentNo: adjustment.documentNo, type: input.adjustmentType, lines: input.lines.length }));
    return this.load(tx, claims.org, adjustment.id as string);
  }

  private async postDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    adjustmentId: string,
  ): Promise<unknown> {
    const a = await tx.query("SELECT * FROM stock_adjustments WHERE id = $1 AND org_id = $2 AND status = 'draft'", [adjustmentId, claims.org]);
    if (a.rows.length === 0) throw new NotFoundException("Adjustment not found or not draft");
    const row = a.rows[0];

    const lines = await tx.query(
      "SELECT line_no, variant_id, quantity, unit_cost, batch_id FROM stock_adjustment_lines WHERE adjustment_id = $1 ORDER BY line_no",
      [adjustmentId],
    );
    if (lines.rows.length === 0) throw new BadRequestException("Cannot post an adjustment with no lines");

    // Oversell resolution: a decrease must be covered by on-hand stock.
    for (const line of lines.rows) {
      if (row.adjustment_type !== "decrease") continue;
      if (line.batch_id) {
        const b = await tx.query(
          `SELECT COALESCE(SUM(quantity), 0)::numeric(14,4) AS on_hand
           FROM stock_ledger WHERE batch_id = $1 AND branch_id = $2`,
          [line.batch_id, row.branch_id],
        );
        if (Number(b.rows[0].on_hand) < Number(line.quantity)) {
          throw new BadRequestException(`line ${line.line_no}: cannot decrease below zero (batch)`);
        }
      } else {
        const bal = await tx.query(
          "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
          [claims.org, row.branch_id, line.variant_id],
        );
        if (Number(bal.rows[0]?.quantity_on_hand ?? 0) < Number(line.quantity)) {
          throw new BadRequestException(`line ${line.line_no}: cannot decrease below zero`);
        }
      }
    }

    for (const line of lines.rows) {
      const signed = row.adjustment_type === "decrease" ? `-${line.quantity}` : line.quantity;
      await tx.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
            reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id, notes)
         VALUES ($1, $2, $3, 'adjustment', $4::numeric(14,4), $5::numeric(14,4), $6,
                 'adjustment', $7, 'adjustment:' || $8 || ':' || $9, now(), $10, $11, $12)`,
        [
          claims.org,
          row.branch_id,
          line.variant_id,
          signed,
          line.unit_cost,
          line.batch_id,
          adjustmentId,
          row.client_operation_id,
          line.line_no,
          claims.sub,
          claims.dev ?? null,
          row.reason,
        ],
      );
    }

    await tx.query("UPDATE stock_adjustments SET status = 'posted', posted_at = now() WHERE id = $1 AND org_id = $2", [adjustmentId, claims.org]);
    await this.audit.write(tx, "adjustment.post", "stock_adjustment", adjustmentId, null, JSON.stringify({ documentNo: row.document_no, lines: lines.rows.length }));
    return this.load(tx, claims.org, adjustmentId);
  }

  private async load(
    tx: DbExecutor,
    orgId: string,
    adjustmentId: string,
  ): Promise<unknown> {
    const a = await tx.query(`SELECT ${ADJUSTMENT_COLS} FROM stock_adjustments WHERE id = $1 AND org_id = $2`, [adjustmentId, orgId]);
    if (a.rows.length === 0) throw new NotFoundException("Adjustment not found");
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.variant_id AS "variantId", l.quantity,
              l.unit_cost AS "unitCost", l.batch_id AS "batchId", b.batch_no AS "batchNo"
       FROM stock_adjustment_lines l
       LEFT JOIN batches b ON b.id = l.batch_id
       WHERE l.adjustment_id = $1 AND l.org_id = $2
       ORDER BY l.line_no`,
      [adjustmentId, orgId],
    );
    return { ...a.rows[0], lines: lines.rows };
  }
}

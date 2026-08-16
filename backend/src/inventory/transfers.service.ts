import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDecimal, requireString } from "./validate.js";

export interface TransferLineInput {
  variantId: string;
  /** decimal STRING */
  quantity: string;
  /** Optional — FEFO picks the source batch when omitted. */
  batchId?: string;
}

export interface CreateTransferInput {
  clientOperationId: string;
  fromBranchId: string;
  toBranchId: string;
  notes?: string;
  lines: TransferLineInput[];
}

const TRANSFER_COLS = `id, from_branch_id AS "fromBranchId", to_branch_id AS "toBranchId",
  document_no AS "documentNo", status, client_operation_id AS "clientOperationId", notes,
  created_by_user_id AS "createdByUserId", created_by_device_id AS "createdByDeviceId",
  posted_at AS "postedAt", created_at AS "createdAt"`;

function docNo(): string {
  return `TRF-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

@Injectable()
export class TransfersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Creates a draft transfer. Replaying the same clientOperationId returns the draft. */
  async create(claims: JwtPayloadClaims, input: CreateTransferInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateLines(input.lines);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id FROM stock_transfers WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) return this.load(tx, claims.org, existing.rows[0].id as string);
        return this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
      },
    );
  }

  /**
   * Posts a draft: source-stock validation + BOTH ledger legs (transfer_out at
   * the source branch, transfer_in at the destination) in ONE transaction
   * (Invariant 3). Replay-safe: posting an already-posted transfer returns the
   * stored document.
   */
  async post(claims: JwtPayloadClaims, transferId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM stock_transfers WHERE id = $1 AND org_id = $2", [transferId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Transfer not found");
        if (existing.rows[0].status === "posted") return this.load(tx, claims.org, transferId);
        return this.postDraft(tx, claims, transferId);
      },
    );
  }

  /** Single-transaction create+post — the offline outbox path (Invariant 3). */
  async createAndPost(claims: JwtPayloadClaims, input: CreateTransferInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    this.validateLines(input.lines);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM stock_transfers WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].status === "posted") return this.load(tx, claims.org, existing.rows[0].id as string);
          return this.postDraft(tx, claims, existing.rows[0].id as string);
        }
        const draft = await this.insertDraft(tx, claims, { ...input, clientOperationId: opId });
        return this.postDraft(tx, claims, (draft as { id: string }).id);
      },
    );
  }

  async get(claims: JwtPayloadClaims, transferId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.load(tx, claims.org, transferId),
    );
  }

  async list(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["t.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`(t.from_branch_id = $${params.length} OR t.to_branch_id = $${params.length})`);
        }
        if (status === "draft" || status === "posted") {
          params.push(status);
          clauses.push(`t.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT t.id, t.from_branch_id AS "fromBranchId", t.to_branch_id AS "toBranchId",
                  t.document_no AS "documentNo", t.status, t.posted_at AS "postedAt", t.created_at AS "createdAt",
                  COUNT(l.id)::int AS "lineCount",
                  COALESCE(SUM(l.quantity), 0)::numeric(14,4) AS "totalQuantity"
           FROM stock_transfers t
           LEFT JOIN stock_transfer_lines l ON l.transfer_id = t.id
           WHERE ${clauses.join(" AND ")}
           GROUP BY t.id
           ORDER BY t.created_at DESC LIMIT 200`,
          params,
        );
        return { transfers: r.rows };
      },
    );
  }

  // ---- internals -------------------------------------------------------------

  private validateLines(lines: TransferLineInput[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestException("a transfer needs at least one line");
    }
    for (const [i, l] of lines.entries()) {
      requireString(l.variantId, `lines[${i}].variantId`);
      assertDecimal(l.quantity, `lines[${i}].quantity`, { allowZero: false });
      if (l.batchId !== undefined && l.batchId !== null && typeof l.batchId !== "string") {
        throw new BadRequestException(`lines[${i}].batchId must be a string`);
      }
    }
  }

  private async insertDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    input: CreateTransferInput,
  ): Promise<unknown> {
    const fromBranch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [input.fromBranchId, claims.org]);
    if (fromBranch.rows.length === 0) throw new BadRequestException("Unknown or inactive source branch");
    const toBranch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [input.toBranchId, claims.org]);
    if (toBranch.rows.length === 0) throw new BadRequestException("Unknown or inactive destination branch");
    if (input.fromBranchId === input.toBranchId) throw new BadRequestException("Source and destination branch must differ");

    // Variants must belong to the org (FK checks bypass RLS, so check explicitly).
    for (const [i, l] of input.lines.entries()) {
      const v = await tx.query("SELECT id FROM product_variants WHERE id = $1 AND org_id = $2 AND is_active", [l.variantId, claims.org]);
      if (v.rows.length === 0) throw new BadRequestException(`lines[${i}].variantId is unknown or inactive`);
      if (l.batchId) {
        const b = await tx.query(
          "SELECT id FROM batches WHERE id = $1 AND org_id = $2 AND variant_id = $3 AND branch_id = $4",
          [l.batchId, claims.org, l.variantId, input.fromBranchId],
        );
        if (b.rows.length === 0) throw new BadRequestException(`lines[${i}].batchId does not exist at the source branch`);
      }
    }

    let transfer;
    try {
      const r = await tx.query(
        `INSERT INTO stock_transfers (org_id, from_branch_id, to_branch_id, document_no, client_operation_id, notes,
                                      created_by_user_id, created_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${TRANSFER_COLS}`,
        [claims.org, input.fromBranchId, input.toBranchId, docNo(), input.clientOperationId, input.notes ?? null, claims.sub, claims.dev ?? null],
      );
      transfer = r.rows[0];
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictException("A transfer with this clientOperationId already exists");
      }
      throw err;
    }

    for (const [i, l] of input.lines.entries()) {
      await tx.query(
        `INSERT INTO stock_transfer_lines (org_id, transfer_id, line_no, variant_id, quantity, batch_id)
         VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6)`,
        [claims.org, transfer.id, i + 1, l.variantId, l.quantity, l.batchId ?? null],
      );
    }

    await this.audit.write(tx, "transfer.create", "stock_transfer", transfer.id, null, JSON.stringify({ documentNo: transfer.documentNo, lines: input.lines.length }));
    return this.load(tx, claims.org, transfer.id as string);
  }

  private async postDraft(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    transferId: string,
  ): Promise<unknown> {
    const t = await tx.query("SELECT * FROM stock_transfers WHERE id = $1 AND org_id = $2 AND status = 'draft'", [transferId, claims.org]);
    if (t.rows.length === 0) throw new NotFoundException("Transfer not found or not draft");
    const row = t.rows[0];

    const lines = await tx.query(
      "SELECT line_no, variant_id, quantity, batch_id FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY line_no",
      [transferId],
    );
    if (lines.rows.length === 0) throw new BadRequestException("Cannot post a transfer with no lines");

    // Validate source stock for every line BEFORE writing any movement — the
    // whole transfer commits or rolls back together (oversell resolution).
    for (const line of lines.rows) {
      if (line.batch_id) {
        const b = await tx.query(
          `SELECT COALESCE(SUM(quantity), 0)::numeric(14,4) AS on_hand
           FROM stock_ledger WHERE batch_id = $1 AND branch_id = $2`,
          [line.batch_id, row.from_branch_id],
        );
        if (Number(b.rows[0].on_hand) < Number(line.quantity)) {
          throw new BadRequestException(`line ${line.line_no}: insufficient stock on hand at source branch`);
        }
      } else {
        const bal = await tx.query(
          "SELECT quantity_on_hand FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
          [claims.org, row.from_branch_id, line.variant_id],
        );
        if (Number(bal.rows[0]?.quantity_on_hand ?? 0) < Number(line.quantity)) {
          throw new BadRequestException(`line ${line.line_no}: insufficient stock on hand at source branch`);
        }
      }
    }

    for (const line of lines.rows) {
      // Leg 1 — stock leaves the source branch.
      await tx.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
            reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id, notes)
         VALUES ($1, $2, $3, 'transfer_out', -$4::numeric(14,4), NULL, $5,
                 'transfer', $6, 'transfer:' || $7 || ':' || $8 || ':out', now(), $9, $10, $11)`,
        [
          claims.org,
          row.from_branch_id,
          line.variant_id,
          line.quantity,
          line.batch_id,
          transferId,
          row.client_operation_id,
          line.line_no,
          claims.sub,
          claims.dev ?? null,
          `to branch ${row.to_branch_id}`,
        ],
      );
      // Leg 2 — stock arrives at the destination branch (same batch id; the
      // batch metadata lives at the origin, balances are ledger-derived).
      await tx.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
            reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id, notes)
         VALUES ($1, $2, $3, 'transfer_in', $4::numeric(14,4), NULL, $5,
                 'transfer', $6, 'transfer:' || $7 || ':' || $8 || ':in', now(), $9, $10, $11)`,
        [
          claims.org,
          row.to_branch_id,
          line.variant_id,
          line.quantity,
          line.batch_id,
          transferId,
          row.client_operation_id,
          line.line_no,
          claims.sub,
          claims.dev ?? null,
          `from branch ${row.from_branch_id}`,
        ],
      );
    }

    const r = await tx.query(
      `UPDATE stock_transfers SET status = 'posted', posted_at = now() WHERE id = $1 AND org_id = $2 RETURNING ${TRANSFER_COLS}`,
      [transferId, claims.org],
    );
    await this.audit.write(tx, "transfer.post", "stock_transfer", transferId, null, JSON.stringify({ documentNo: row.document_no, lines: lines.rows.length }));
    return this.load(tx, claims.org, transferId);
  }

  private async load(
    tx: DbExecutor,
    orgId: string,
    transferId: string,
  ): Promise<unknown> {
    const t = await tx.query(`SELECT ${TRANSFER_COLS} FROM stock_transfers WHERE id = $1 AND org_id = $2`, [transferId, orgId]);
    if (t.rows.length === 0) throw new NotFoundException("Transfer not found");
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.variant_id AS "variantId", l.quantity,
              l.batch_id AS "batchId", b.batch_no AS "batchNo"
       FROM stock_transfer_lines l
       LEFT JOIN batches b ON b.id = l.batch_id
       WHERE l.transfer_id = $1 AND l.org_id = $2
       ORDER BY l.line_no`,
      [transferId, orgId],
    );
    return { ...t.rows[0], lines: lines.rows };
  }
}

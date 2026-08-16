import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDecimal, requireString } from "./validate.js";

export interface CreateCountInput {
  clientOperationId: string;
  branchId: string;
  notes?: string;
  /** Blind: the counter lists the variants to count — expected is hidden. */
  variantIds: string[];
}

export interface CountRecordInput {
  /** decimal STRINGs — the blind count the counter actually saw */
  counted: { variantId: string; quantity: string }[];
}

const COUNT_COLS = `id, branch_id AS "branchId", document_no AS "documentNo", status,
  client_operation_id AS "clientOperationId", notes,
  created_by_user_id AS "createdByUserId", created_by_device_id AS "createdByDeviceId",
  posted_at AS "postedAt", created_at AS "createdAt"`;

function docNo(): string {
  return `CNT-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

@Injectable()
export class CountsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Opens a blind count for a branch (one live count per branch). Lines carry
   * NO expected quantity — the counter sees only the variant list.
   * Replaying the same clientOperationId returns the open count.
   */
  async create(claims: JwtPayloadClaims, input: CreateCountInput): Promise<unknown> {
    const opId = requireString(input.clientOperationId, "clientOperationId");
    if (!Array.isArray(input.variantIds) || input.variantIds.length === 0) {
      throw new BadRequestException("a count needs at least one variant");
    }

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id FROM stock_counts WHERE org_id = $1 AND client_operation_id = $2", [claims.org, opId]);
        if (existing.rows.length > 0) return this.load(tx, claims.org, existing.rows[0].id as string);

        const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active", [input.branchId, claims.org]);
        if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

        for (const [i, vid] of input.variantIds.entries()) {
          const v = await tx.query("SELECT id FROM product_variants WHERE id = $1 AND org_id = $2 AND is_active", [vid, claims.org]);
          if (v.rows.length === 0) throw new BadRequestException(`variantIds[${i}] is unknown or inactive`);
        }

        let count;
        try {
          const r = await tx.query(
            `INSERT INTO stock_counts (org_id, branch_id, document_no, client_operation_id, notes,
                                       created_by_user_id, created_by_device_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING ${COUNT_COLS}`,
            [claims.org, input.branchId, docNo(), opId, input.notes ?? null, claims.sub, claims.dev ?? null],
          );
          count = r.rows[0];
        } catch (err) {
          if ((err as { code?: string })?.code === "23505") {
            // Partial unique index (org, branch) where status open/counted.
            throw new ConflictException("A count is already open for this branch");
          }
          throw err;
        }

        for (const [i, vid] of input.variantIds.entries()) {
          await tx.query(
            `INSERT INTO stock_count_lines (org_id, count_id, line_no, variant_id)
             VALUES ($1, $2, $3, $4)`,
            [claims.org, count.id, i + 1, vid],
          );
        }

        await this.audit.write(tx, "count.create", "stock_count", count.id, null, JSON.stringify({ documentNo: count.documentNo, variants: input.variantIds.length }));
        return this.load(tx, claims.org, count.id as string);

      },
    );
  }

  /**
   * Records the BLIND count per line. The counter never sees expected
   * quantities — the server holds them until post. Idempotent upsert.
   */
  async record(claims: JwtPayloadClaims, countId: string, input: CountRecordInput): Promise<unknown> {
    const counted = input.counted ?? [];
    if (counted.length === 0) throw new BadRequestException("counted must not be empty");
    for (const [i, c] of counted.entries()) {
      requireString(c.variantId, `counted[${i}].variantId`);
      assertDecimal(c.quantity, `counted[${i}].quantity`, { allowZero: true });
    }

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const count = await tx.query(
          "SELECT id, status, branch_id, client_operation_id, document_no FROM stock_counts WHERE id = $1 AND org_id = $2",
          [countId, claims.org],
        );
        if (count.rows.length === 0) throw new NotFoundException("Count not found");
        if (count.rows[0].status === "posted") throw new BadRequestException("A posted count is immutable");

        const lines = await tx.query(
          "SELECT id, line_no, variant_id, counted_quantity FROM stock_count_lines WHERE count_id = $1 AND org_id = $2",
          [countId, claims.org],
        );
        const lineByVariant = new Map(lines.rows.map((l) => [l.variant_id as string, l]));

        for (const [i, c] of counted.entries()) {
          const line = lineByVariant.get(c.variantId);
          if (!line) throw new BadRequestException(`counted[${i}].variantId is not part of this count`);
          await tx.query(
            "UPDATE stock_count_lines SET counted_quantity = $3::numeric(14,4) WHERE id = $1 AND org_id = $2",
            [line.id, claims.org, c.quantity],
          );
        }

        // A count is ready to post once every line has a counted quantity.
        const remaining = await tx.query(
          "SELECT count(*)::int AS n FROM stock_count_lines WHERE count_id = $1 AND org_id = $2 AND counted_quantity IS NULL",
          [countId, claims.org],
        );
        if (remaining.rows[0].n === 0 && count.rows[0].status === "open") {
          await tx.query("UPDATE stock_counts SET status = 'counted' WHERE id = $1 AND org_id = $2", [countId, claims.org]);
        }

        await this.audit.write(tx, "count.record", "stock_count", countId, null, JSON.stringify({ lines: counted.length }));
        return this.load(tx, claims.org, countId);
      },
    );
  }

  /**
   * Posts the count: for every line the SERVER snapshots expected_quantity
   * (from inventory_items — never client-supplied) and writes the signed
   * count_adjustment movement for the variance. All in ONE transaction
   * (Invariant 3). Requires stock.count.approve. Replay-safe.
   */
  async post(claims: JwtPayloadClaims, countId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, status FROM stock_counts WHERE id = $1 AND org_id = $2", [countId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Count not found");
        if (existing.rows[0].status === "posted") return this.load(tx, claims.org, countId);

        return this.postCount(tx, claims, countId);
      },
    );
  }

  async get(claims: JwtPayloadClaims, countId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.load(tx, claims.org, countId),
    );
  }

  async list(claims: JwtPayloadClaims, branchId?: string, status?: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["c.org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`c.branch_id = $${params.length}`);
        }
        if (status === "open" || status === "counted" || status === "posted") {
          params.push(status);
          clauses.push(`c.status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT c.id, c.branch_id AS "branchId", c.document_no AS "documentNo", c.status,
                  c.posted_at AS "postedAt", c.created_at AS "createdAt",
                  COUNT(l.id)::int AS "lineCount",
                  COUNT(l.counted_quantity)::int AS "countedLineCount"
           FROM stock_counts c
           LEFT JOIN stock_count_lines l ON l.count_id = c.id
           WHERE ${clauses.join(" AND ")}
           GROUP BY c.id
           ORDER BY c.created_at DESC LIMIT 200`,
          params,
        );
        return { counts: r.rows };
      },
    );
  }

  // ---- internals -------------------------------------------------------------

  private async postCount(
    tx: DbExecutor,
    claims: JwtPayloadClaims,
    countId: string,
  ): Promise<unknown> {
    const count = await tx.query(
      "SELECT id, branch_id, client_operation_id, document_no FROM stock_counts WHERE id = $1 AND org_id = $2 AND status = 'counted'",
      [countId, claims.org],
    );
    if (count.rows.length === 0) throw new BadRequestException("Count is not ready to post (record every line first)");
    const row = count.rows[0];

    const lines = await tx.query(
      "SELECT id, line_no, variant_id, counted_quantity FROM stock_count_lines WHERE count_id = $1 AND org_id = $2 ORDER BY line_no",
      [countId, claims.org],
    );
    for (const line of lines.rows) {
      const expected = await tx.query(
        "SELECT COALESCE(quantity_on_hand, 0)::numeric(14,4) AS q FROM inventory_items WHERE org_id = $1 AND branch_id = $2 AND variant_id = $3",
        [claims.org, row.branch_id, line.variant_id],
      );
      const expectedQty = expected.rows[0].q as string;
      const variance = (Number(line.counted_quantity) - Number(expectedQty)).toFixed(4);

      if (Number(variance) !== 0) {
        await tx.query(
          `INSERT INTO stock_ledger
             (org_id, branch_id, variant_id, movement_type, quantity, unit_cost, batch_id,
              reference_type, reference_id, idempotency_key, business_time, created_by_user_id, created_by_device_id, notes)
           VALUES ($1, $2, $3, 'count_adjustment', $4::numeric(14,4), NULL, NULL,
                   'count', $5, 'count:' || $6 || ':' || $7, now(), $8, $9, $10)`,
          [
            claims.org,
            row.branch_id,
            line.variant_id,
            variance,
            countId,
            row.client_operation_id,
            line.line_no,
            claims.sub,
            claims.dev ?? null,
            `count ${row.document_no}`,
          ],
        );
      }

      // Snapshot expected + variance onto the line at post time (traceable).
      await tx.query(
        "UPDATE stock_count_lines SET expected_quantity = $3::numeric(14,4), variance = $4::numeric(14,4) WHERE id = $1 AND org_id = $2",
        [line.id, claims.org, expectedQty, variance],
      );
    }

    await tx.query("UPDATE stock_counts SET status = 'posted', posted_at = now() WHERE id = $1 AND org_id = $2", [countId, claims.org]);
    await this.audit.write(tx, "count.post", "stock_count", countId, null, JSON.stringify({ documentNo: row.document_no, lines: lines.rows.length }));
    return this.load(tx, claims.org, countId);
  }

  private async load(
    tx: DbExecutor,
    orgId: string,
    countId: string,
  ): Promise<unknown> {
    const c = await tx.query(`SELECT ${COUNT_COLS} FROM stock_counts WHERE id = $1 AND org_id = $2`, [countId, orgId]);
    if (c.rows.length === 0) throw new NotFoundException("Count not found");
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.variant_id AS "variantId", l.counted_quantity AS "countedQuantity",
              l.expected_quantity AS "expectedQuantity", l.variance
       FROM stock_count_lines l
       WHERE l.count_id = $1 AND l.org_id = $2
       ORDER BY l.line_no`,
      [countId, orgId],
    );
    return { ...c.rows[0], lines: lines.rows };
  }
}

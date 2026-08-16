import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export interface OpenShiftInput {
  branchId: string;
  /** decimal STRING — the opening float */
  openingCash?: string;
  notes?: string;
}

export interface CloseShiftInput {
  shiftId: string;
  /** decimal STRINGs — declared tender counts at cash-up */
  declaredCash: string;
  declaredCard: string;
  declaredMobileMoney: string;
  declaredCredit: string;
  declaredOther: string;
  notes?: string;
}

function assertDecimal(value: unknown, name: string, allowZero: boolean): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new BadRequestException(`${name} must be a decimal string (up to 4 dp)`);
  }
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || (!allowZero && n === 0)) {
    throw new BadRequestException(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return value;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

const SHIFT_COLS = `id, branch_id AS "branchId", user_id AS "userId", device_id AS "deviceId",
  status, opened_at AS "openedAt", closed_at AS "closedAt", opening_cash AS "openingCash",
  declared_cash AS "declaredCash", declared_card AS "declaredCard",
  declared_mobile_money AS "declaredMobileMoney", declared_credit AS "declaredCredit",
  declared_other AS "declaredOther", expected_cash AS "expectedCash",
  expected_total AS "expectedTotal", variance, notes, created_at AS "createdAt"`;

@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Opens a till shift for a branch, carrying the opening float. */
  async open(claims: JwtPayloadClaims, input: OpenShiftInput): Promise<unknown> {
    if (typeof input.branchId !== "string" || !input.branchId) {
      throw new BadRequestException("branchId is required");
    }
    const openingCash = input.openingCash ? assertDecimal(input.openingCash, "openingCash", true) : "0";

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const branch = await tx.query(
          "SELECT id FROM branches WHERE id = $1 AND org_id = $2 AND is_active",
          [input.branchId, claims.org],
        );
        if (branch.rows.length === 0) throw new BadRequestException("Unknown or inactive branch");

        let inserted;
        try {
          const r = await tx.query(
            `INSERT INTO shifts (org_id, branch_id, user_id, device_id, opening_cash, notes)
             VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6)
             RETURNING ${SHIFT_COLS}`,
            [claims.org, input.branchId, claims.sub, claims.dev ?? null, openingCash, input.notes ?? null],
          );
          inserted = r.rows[0];
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException("A shift is already open for this branch");
          }
          throw err;
        }

        await this.audit.write(
          tx,
          "shift.open",
          "shift",
          inserted.id,
          null,
          JSON.stringify({ branchId: input.branchId, openingCash }),
        );
        return inserted;
      },
    );
  }

  /**
   * Cash-up: DECLARED tenders are compared against SERVER-computed
   * expectations derived from the shift's completed sales and refunds.
   * Closing an already-closed shift is idempotent (returns the stored result).
   */
  async close(claims: JwtPayloadClaims, input: CloseShiftInput): Promise<unknown> {
    const declared = {
      cash: assertDecimal(input.declaredCash ?? "0", "declaredCash", true),
      card: assertDecimal(input.declaredCard ?? "0", "declaredCard", true),
      mobileMoney: assertDecimal(input.declaredMobileMoney ?? "0", "declaredMobileMoney", true),
      credit: assertDecimal(input.declaredCredit ?? "0", "declaredCredit", true),
      other: assertDecimal(input.declaredOther ?? "0", "declaredOther", true),
    };

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `WITH calc AS (
             SELECT s.id AS shift_id,
                    s.opening_cash
                      + COALESCE((SELECT SUM(sl.total) FROM sales sl
                                  WHERE sl.shift_id = s.id AND sl.org_id = s.org_id
                                    AND sl.status = 'completed'), 0)
                      - COALESCE((SELECT SUM(rf.amount) FROM sale_refunds rf
                                  JOIN sales sl ON sl.id = rf.sale_id
                                  WHERE sl.shift_id = s.id AND sl.org_id = s.org_id), 0)
                      AS total_expected,
                    s.opening_cash
                      + COALESCE((SELECT SUM(st.amount) FROM sale_tenders st
                                  JOIN sales sl ON sl.id = st.sale_id
                                  WHERE sl.shift_id = s.id AND sl.org_id = s.org_id
                                    AND sl.status = 'completed' AND st.tender_type = 'cash'), 0)
                      AS cash_expected
             FROM shifts s
             WHERE s.id = $1 AND s.org_id = $2 AND s.status = 'open'
           )
           UPDATE shifts s
           SET status = 'closed',
               closed_at = now(),
               declared_cash = $3::numeric(14,4),
               declared_card = $4::numeric(14,4),
               declared_mobile_money = $5::numeric(14,4),
               declared_credit = $6::numeric(14,4),
               declared_other = $7::numeric(14,4),
               expected_cash = calc.cash_expected::numeric(14,4),
               expected_total = calc.total_expected::numeric(14,4),
               variance = ($3::numeric(14,4) + $4::numeric(14,4) + $5::numeric(14,4)
                           + $6::numeric(14,4) + $7::numeric(14,4) - calc.total_expected)::numeric(14,4),
               notes = COALESCE($8, s.notes)
           FROM calc
           WHERE s.id = calc.shift_id
           RETURNING ${SHIFT_COLS}`,
          [
            input.shiftId,
            claims.org,
            declared.cash,
            declared.card,
            declared.mobileMoney,
            declared.credit,
            declared.other,
            input.notes ?? null,
          ],
        );

        if (r.rows.length > 0) {
          await this.audit.write(
            tx,
            "shift.close",
            "shift",
            input.shiftId,
            null,
            JSON.stringify(r.rows[0]),
          );
          return r.rows[0];
        }

        // Nothing updated: the shift is already closed (idempotent replay) —
        // return the stored result — or it does not exist.
        const existing = await tx.query(
          `SELECT ${SHIFT_COLS} FROM shifts WHERE id = $1 AND org_id = $2`,
          [input.shiftId, claims.org],
        );
        if (existing.rows.length === 0) throw new NotFoundException("Shift not found");
        return existing.rows[0];
      },
    );
  }

  async get(claims: JwtPayloadClaims, shiftId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `SELECT ${SHIFT_COLS} FROM shifts WHERE id = $1 AND org_id = $2`,
          [shiftId, claims.org],
        );
        if (r.rows.length === 0) throw new NotFoundException("Shift not found");
        return r.rows[0];
      },
    );
  }

  async list(
    claims: JwtPayloadClaims,
    branchId?: string,
    status?: string,
  ): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const clauses = ["org_id = $1"];
        const params: unknown[] = [claims.org];
        if (branchId) {
          params.push(branchId);
          clauses.push(`branch_id = $${params.length}`);
        }
        if (status === "open" || status === "closed") {
          params.push(status);
          clauses.push(`status = $${params.length}`);
        }
        const r = await tx.query(
          `SELECT ${SHIFT_COLS} FROM shifts WHERE ${clauses.join(" AND ")} ORDER BY opened_at DESC LIMIT 200`,
          params,
        );
        return { shifts: r.rows };
      },
    );
  }
}

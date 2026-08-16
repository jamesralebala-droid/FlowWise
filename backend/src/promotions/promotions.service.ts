import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export interface PromotionInput {
  code?: string;
  name?: string;
  discountType?: "percentage" | "amount";
  discountValue?: string;
  minSpend?: string;
  usageLimit?: number | null;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

function assertDecimal(value: string, name: string, allowZero = false): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new BadRequestException(`${name} must be a decimal string (up to 4 dp)`);
  }
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || (!allowZero && n === 0)) {
    throw new BadRequestException(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return value;
}

function cleanPromotionInput(input: PromotionInput): PromotionInput {
  const out: PromotionInput = {};
  if (input.code !== undefined) {
    const code = String(input.code).trim().toUpperCase();
    if (!code) throw new BadRequestException("code is required");
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
      throw new BadRequestException("code must be 2-32 chars of A-Z, 0-9, _ or -");
    }
    out.code = code;
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new BadRequestException("name is required");
    out.name = name;
  }
  if (input.discountType !== undefined) {
    if (input.discountType !== "percentage" && input.discountType !== "amount") {
      throw new BadRequestException("discountType must be percentage or amount");
    }
    out.discountType = input.discountType;
  }
  if (input.discountValue !== undefined) {
    const v = assertDecimal(String(input.discountValue), "discountValue");
    if (out.discountType === "percentage" && Number(v) > 1) {
      throw new BadRequestException("percentage discountValue must be <= 1 (100%)");
    }
    out.discountValue = v;
  }
  if (input.minSpend !== undefined) out.minSpend = assertDecimal(String(input.minSpend), "minSpend", true);
  if (input.usageLimit !== undefined && input.usageLimit !== null) {
    const n = Number(input.usageLimit);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException("usageLimit must be a positive integer or null");
    out.usageLimit = n;
  }
  if (input.isActive !== undefined) out.isActive = Boolean(input.isActive);
  if (input.startsAt !== undefined && input.startsAt !== null) {
    const d = new Date(input.startsAt);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("startsAt must be an ISO timestamp");
    out.startsAt = d.toISOString();
  }
  if (input.endsAt !== undefined && input.endsAt !== null) {
    const d = new Date(input.endsAt);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("endsAt must be an ISO timestamp");
    out.endsAt = d.toISOString();
  }
  return out;
}

@Injectable()
export class PromotionsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(claims: JwtPayloadClaims, opts: { activeOnly?: boolean } = {}): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const params: unknown[] = [claims.org];
        let where = "org_id = $1";
        if (opts.activeOnly) {
          where += ` AND is_active
                     AND (starts_at IS NULL OR starts_at <= now())
                     AND (ends_at IS NULL OR ends_at >= now())`;
        }
        const r = await tx.query(
          `SELECT id, code, name, discount_type AS "discountType", discount_value AS "discountValue",
                  min_spend AS "minSpend", usage_limit AS "usageLimit", times_used AS "timesUsed",
                  is_active AS "isActive", starts_at AS "startsAt", ends_at AS "endsAt",
                  created_at AS "createdAt", updated_at AS "updatedAt"
           FROM promotions
           WHERE ${where}
           ORDER BY created_at DESC
           LIMIT 200`,
          params,
        );
        return { promotions: r.rows };
      },
    );
  }

  async create(claims: JwtPayloadClaims, input: PromotionInput): Promise<unknown> {
    const cleaned = cleanPromotionInput(input);
    if (!cleaned.code) throw new BadRequestException("code is required");
    if (!cleaned.discountType) throw new BadRequestException("discountType is required");
    if (!cleaned.discountValue) throw new BadRequestException("discountValue is required");
    const code = cleaned.code;
    const discountType = cleaned.discountType;
    const discountValue = cleaned.discountValue;

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const dup = await tx.query("SELECT id FROM promotions WHERE org_id = $1 AND lower(code) = $2", [
          claims.org,
          code.toLowerCase(),
        ]);
        if (dup.rows.length > 0) throw new BadRequestException("A promotion with this code already exists");
        const r = await tx.query(
          `INSERT INTO promotions
             (org_id, code, name, discount_type, discount_value, min_spend, usage_limit,
              is_active, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6::numeric(14,4), $7, $8, $9::timestamptz, $10::timestamptz)
           RETURNING id, code, name, discount_type AS "discountType", discount_value AS "discountValue",
                     min_spend AS "minSpend", usage_limit AS "usageLimit", times_used AS "timesUsed",
                     is_active AS "isActive", starts_at AS "startsAt", ends_at AS "endsAt"`,
          [
            claims.org,
            code,
            cleaned.name ?? code,
            discountType,
            discountValue,
            cleaned.minSpend ?? "0",
            cleaned.usageLimit ?? null,
            cleaned.isActive ?? true,
            cleaned.startsAt ?? null,
            cleaned.endsAt ?? null,
          ],
        );
        const id = r.rows[0].id as string;
        await this.audit.write(tx, "promotion.create", "promotion", id, null, JSON.stringify(cleaned));
        return r.rows[0];
      },
    );
  }

  async update(claims: JwtPayloadClaims, promotionId: string, input: PromotionInput): Promise<unknown> {
    const cleaned = cleanPromotionInput(input);

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query("SELECT id, code FROM promotions WHERE id = $1 AND org_id = $2", [
          promotionId,
          claims.org,
        ]);
        if (existing.rows.length === 0) throw new NotFoundException("Promotion not found");
        if (cleaned.code) {
          const dup = await tx.query(
            "SELECT id FROM promotions WHERE org_id = $1 AND lower(code) = $2 AND id <> $3",
            [claims.org, cleaned.code.toLowerCase(), promotionId],
          );
          if (dup.rows.length > 0) throw new BadRequestException("A promotion with this code already exists");
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        const push = (col: string, v: unknown, cast = "") => {
          params.push(v);
          sets.push(`${col} = $${params.length}${cast}`);
        };
        if (cleaned.code !== undefined) push("code", cleaned.code);
        if (cleaned.name !== undefined) push("name", cleaned.name);
        if (cleaned.discountType !== undefined) push("discount_type", cleaned.discountType);
        if (cleaned.discountValue !== undefined) push("discount_value", cleaned.discountValue, "::numeric(14,4)");
        if (cleaned.minSpend !== undefined) push("min_spend", cleaned.minSpend, "::numeric(14,4)");
        if (cleaned.usageLimit !== undefined) push("usage_limit", cleaned.usageLimit);
        if (cleaned.isActive !== undefined) push("is_active", cleaned.isActive);
        if (cleaned.startsAt !== undefined) push("starts_at", cleaned.startsAt, "::timestamptz");
        if (cleaned.endsAt !== undefined) push("ends_at", cleaned.endsAt, "::timestamptz");
        if (sets.length === 0) throw new BadRequestException("Nothing to update");
        params.push(promotionId, claims.org);
        const r = await tx.query(
          `UPDATE promotions SET ${sets.join(", ")}, updated_at = now()
           WHERE id = $${params.length - 1} AND org_id = $${params.length}
           RETURNING id, code, name, discount_type AS "discountType", discount_value AS "discountValue",
                     min_spend AS "minSpend", usage_limit AS "usageLimit", times_used AS "timesUsed",
                     is_active AS "isActive", starts_at AS "startsAt", ends_at AS "endsAt"`,
          params,
        );
        await this.audit.write(tx, "promotion.update", "promotion", promotionId, null, JSON.stringify(cleaned));
        return r.rows[0];
      },
    );
  }
}

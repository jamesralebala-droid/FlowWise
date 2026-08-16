import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";

const CODE_RE = /^[A-Z]{3}$/;
const RATE_RE = /^\d{1,8}(\.\d{1,8})?$/;

export interface CurrencyInput {
  code?: string;
  name?: string;
  rateToBase?: string;
}

function cleanInput(input: CurrencyInput): { code?: string; name?: string; rateToBase?: string } {
  const out: { code?: string; name?: string; rateToBase?: string } = {};
  if (input.code !== undefined) {
    const code = String(input.code).trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new BadRequestException("code must be 3 uppercase letters (ISO 4217)");
    out.code = code;
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new BadRequestException("name is required");
    out.name = name;
  }
  if (input.rateToBase !== undefined) {
    const rate = String(input.rateToBase).trim();
    if (!RATE_RE.test(rate)) throw new BadRequestException("rateToBase must be a positive decimal (up to 8 dp)");
    const n = Number(rate);
    if (Number.isNaN(n) || n <= 0) throw new BadRequestException("rateToBase must be greater than zero");
    out.rateToBase = rate;
  }
  return out;
}

@Injectable()
export class CurrenciesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * The org's base currency code (falls back to organisations.currency_code).
   * Accepts an in-flight executor so callers inside a withContext transaction
   * never open a nested transaction (PGlite has no savepoints).
   */
  async baseCurrency(orgId: string, exec?: DbExecutor | null): Promise<string> {
    const run = (tx: DbExecutor) =>
      tx.query(
        `SELECT COALESCE((SELECT code FROM currencies WHERE org_id = $1 AND is_base), currency_code)::text AS code
         FROM organisations WHERE id = $1`,
        [orgId],
      );
    const res = exec ? await run(exec) : await this.db.withSystem(run);
    return (res.rows[0]?.code as string | undefined) ?? "BWP";
  }

  async list(claims: JwtPayloadClaims): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `SELECT code, name, is_base AS "isBase", rate_to_base AS "rateToBase", updated_at AS "updatedAt"
           FROM currencies WHERE org_id = $1 ORDER BY is_base DESC, code`,
          [claims.org],
        );
        // An org that predates the currencies table still sees its base
        // currency (organisations.currency_code, rate 1) listed.
        if (!r.rows.some((row) => row.isBase)) {
          const base = await this.baseCurrency(claims.org, tx);
          r.rows.unshift({ code: base, name: base, isBase: true, rateToBase: "1.00000000", updatedAt: null });
        }
        return { currencies: r.rows };
      },
    );
  }

  async create(claims: JwtPayloadClaims, input: CurrencyInput): Promise<unknown> {
    const cleaned = cleanInput(input);
    if (!cleaned.code || !cleaned.name || !cleaned.rateToBase) {
      throw new BadRequestException("code, name and rateToBase are required");
    }
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const base = await this.baseCurrency(claims.org, tx);
        if (cleaned.code === base) {
          throw new BadRequestException("The base currency already exists — you cannot add a second row for it");
        }
        const dup = await tx.query("SELECT id FROM currencies WHERE org_id = $1 AND code = $2", [claims.org, cleaned.code]);
        if (dup.rows.length > 0) throw new BadRequestException("Currency already exists");
        const r = await tx.query(
          `INSERT INTO currencies (org_id, code, name, is_base, rate_to_base)
           VALUES ($1, $2, $3, false, $4::numeric(14,8))
           RETURNING code, name, is_base AS "isBase", rate_to_base AS "rateToBase"`,
          [claims.org, cleaned.code, cleaned.name, cleaned.rateToBase],
        );
        await this.audit.write(tx, "currency.create", "currency", null, null, JSON.stringify(cleaned));
        return r.rows[0];
      },
    );
  }

  async update(claims: JwtPayloadClaims, code: string, input: CurrencyInput): Promise<unknown> {
    const cleaned = cleanInput({ ...input, code });
    if (cleaned.code !== code) throw new BadRequestException("code cannot be changed");
    if (!cleaned.name && !cleaned.rateToBase) throw new BadRequestException("Nothing to update");
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const row = await tx.query(
          "SELECT code, is_base AS \"isBase\" FROM currencies WHERE org_id = $1 AND code = $2",
          [claims.org, code],
        );
        if (row.rows.length === 0) throw new NotFoundException("Currency not found");
        if (row.rows[0].isBase && cleaned.rateToBase !== undefined && Number(cleaned.rateToBase) !== 1) {
          throw new BadRequestException("The base currency rate is fixed at 1");
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        if (cleaned.name !== undefined) {
          params.push(cleaned.name);
          sets.push(`name = $${params.length}`);
        }
        if (cleaned.rateToBase !== undefined) {
          params.push(cleaned.rateToBase);
          sets.push(`rate_to_base = $${params.length}::numeric(14,8)`);
        }
        params.push(claims.org, code);
        const r = await tx.query(
          `UPDATE currencies SET ${sets.join(", ")}, updated_at = now()
           WHERE org_id = $${params.length - 1} AND code = $${params.length}
           RETURNING code, name, is_base AS "isBase", rate_to_base AS "rateToBase", updated_at AS "updatedAt"`,
          params,
        );
        await this.audit.write(tx, "currency.update", "currency", null, null, JSON.stringify(cleaned));
        return r.rows[0];
      },
    );
  }
}

export type { DbExecutor };

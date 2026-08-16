import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { env } from "../env.js";
import { verifyPassword } from "../password.js";
import { JwtService } from "../auth/jwt.service.js";
import { AuditService } from "../auth/audit.service.js";
import { GrnsService } from "../inventory/grns.service.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export interface SupplierUserRow {
  id: string;
  org_id: string;
  supplier_id: string;
  email: string;
  name: string;
  password_hash: string;
  is_active: boolean;
}

@Injectable()
export class SupplierPortalService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly grns: GrnsService,
  ) {}

  /**
   * Portal login — a direct password exchange (no OAuth codes, no devices).
   * Tokens are short-lived bearer tokens scoped to ONE supplier entity;
   * re-login on expiry. Same brute-force throttle table as the app login.
   */
  async login(input: { email: string; password: string; ipHash?: string }): Promise<unknown> {
    const email = input.email.trim().toLowerCase();
    const ipHash = input.ipHash ?? "unknown";
    const recent = await this.db.withSystem((tx) =>
      tx.query(
        `SELECT count(*)::int AS n
         FROM auth_attempts
         WHERE username = $1 AND ip_hash = $2 AND success = false
           AND attempted_at > now() - make_interval(secs => $3)`,
        [email, ipHash, env.authAttemptWindowSeconds],
      ),
    );
    if ((recent.rows[0].n as number) >= env.authMaxFailedAttempts) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: `Too many failed attempts. Retry in ${env.authAttemptWindowSeconds}s` },
        HttpStatus.TOO_MANY_REQUESTS,
        { cause: "auth-throttled" },
      );
    }
    const recordFailure = () =>
      this.db.withSystem((tx) =>
        tx.query("INSERT INTO auth_attempts (username, ip_hash, success) VALUES ($1, $2, false)", [email, ipHash]),
      );

    const found = await this.db.withSystem((tx) => tx.query("SELECT * FROM auth_lookup_supplier_by_email($1)", [email]));
    const user = found.rows[0] as SupplierUserRow | undefined;
    if (!user || !user.is_active) {
      await recordFailure();
      throw new UnauthorizedException("Invalid credentials");
    }
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      await recordFailure();
      throw new UnauthorizedException("Invalid credentials");
    }
    await this.db.withSystem((tx) =>
      tx.query("DELETE FROM auth_attempts WHERE username = $1 AND ip_hash = $2 AND success = false", [email, ipHash]),
    );

    const { token, expiresIn } = await this.jwt.sign({
      sub: user.id,
      org: user.org_id,
      perms: ["supplier.portal"],
      roles: [],
      dev: null,
      kind: "supplier",
      supplierId: user.supplier_id,
    });
    return {
      accessToken: token,
      tokenType: "Bearer",
      expiresIn,
      supplierId: user.supplier_id,
      name: user.name,
    };
  }

  /** Profile + the supplier entity they represent. */
  async me(orgId: string, supplierId: string): Promise<unknown> {
    const res = await this.db.withContext(
      { orgId, userId: null, deviceId: null },
      (tx) =>
        tx.query(
          `SELECT su.id, su.name, su.email,
                  s.id AS "supplierId", s.name AS "supplierName", s.code AS "supplierCode",
                  s.contact_name AS "contactName", s.contact_phone AS "contactPhone", s.email AS "supplierEmail"
           FROM supplier_users su
           JOIN suppliers s ON s.id = su.supplier_id
           WHERE su.supplier_id = $1`,
          [supplierId],
        ),
    );
    if (res.rows.length === 0) throw new NotFoundException("Supplier account not found");
    return res.rows[0];
  }

  async updateProfile(supplierId: string, orgId: string, input: { name?: string; contactPhone?: string; email?: string }): Promise<unknown> {
    const clean: { name?: string; contactPhone?: string; email?: string } = {};
    if (input.name !== undefined && input.name.trim()) clean.name = input.name.trim();
    if (input.contactPhone !== undefined && input.contactPhone.trim()) clean.contactPhone = input.contactPhone.trim();
    if (input.email !== undefined && input.email.trim()) {
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException("email is invalid");
      clean.email = email;
    }
    if (Object.keys(clean).length === 0) throw new BadRequestException("Nothing to update");

    return this.db.withContext(
      { orgId, userId: null, deviceId: null },
      async (tx) => {
        // supplier_users carries name/email; suppliers carries contact phone.
        const suSets: string[] = [];
        const suParams: unknown[] = [];
        if (clean.name !== undefined) {
          suParams.push(clean.name);
          suSets.push(`name = $${suParams.length}`);
        }
        if (clean.email !== undefined) {
          suParams.push(clean.email);
          suSets.push(`email = $${suParams.length}`);
        }
        if (suSets.length > 0) {
          suParams.push(supplierId);
          const su = await tx.query(
            `UPDATE supplier_users SET ${suSets.join(", ")}, updated_at = now()
             WHERE supplier_id = $${suParams.length} RETURNING id`,
            suParams,
          );
          if (su.rows.length === 0) throw new NotFoundException("Supplier user not found");
        }

        const spSets: string[] = [];
        const spParams: unknown[] = [];
        if (clean.contactPhone !== undefined) {
          spParams.push(clean.contactPhone);
          spSets.push(`contact_phone = $${spParams.length}`);
        }
        if (clean.email !== undefined) {
          spParams.push(clean.email);
          spSets.push(`email = $${spParams.length}`);
        }
        if (spSets.length > 0) {
          spParams.push(supplierId);
          await tx.query(`UPDATE suppliers SET ${spSets.join(", ")} WHERE id = $${spParams.length}`, spParams);
        }
        await this.audit.write(tx, "supplier.profile_update", "supplier", supplierId, null, JSON.stringify(clean));
        return { ok: true };
      },
    );
  }

  /** POs for THIS supplier, newest first, with lines + outstanding. */
  async purchaseOrders(orgId: string, supplierId: string, opts: { status?: string; limit?: number } = {}): Promise<unknown> {
    return this.db.withContext(
      { orgId, userId: null, deviceId: null },
      async (tx) => {
      const clauses = ["po.supplier_id = $1", "po.status <> 'draft'"];
      const params: unknown[] = [supplierId];
      if (opts.status) {
        params.push(opts.status);
        clauses.push(`po.status = $${params.length}`);
      }
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      params.push(limit);
      const pos = await tx.query(
        `SELECT po.id, po.document_no AS "documentNo", po.status, po.expected_delivery AS "expectedDelivery",
                po.notes, po.created_at AS "createdAt", po.sent_at AS "sentAt",
                b.name AS "branchName"
         FROM purchase_orders po
         JOIN branches b ON b.id = po.branch_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY po.created_at DESC LIMIT $${params.length}`,
        params,
      );
      const result = [];
      for (const po of pos.rows) {
        const lines = await tx.query(
          `SELECT pl.line_no AS "lineNo", pl.variant_id AS "variantId", v.name AS "variantName",
                  p.name AS "productName", pl.quantity, pl.unit_cost AS "unitCost",
                  pl.received_quantity AS "receivedQuantity",
                  (pl.quantity - pl.received_quantity) AS "outstandingQuantity"
           FROM purchase_order_lines pl
           JOIN product_variants v ON v.id = pl.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE pl.purchase_order_id = $1 AND pl.org_id = (SELECT org_id FROM purchase_orders WHERE id = $1)
           ORDER BY pl.line_no`,
          [po.id],
        );
        result.push({ ...po, lines: lines.rows });
      }
      return { purchaseOrders: result };
    });
  }

  async purchaseOrder(orgId: string, supplierId: string, poId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId, userId: null, deviceId: null },
      async (tx) => {
      const po = await tx.query(
        `SELECT po.id, po.document_no AS "documentNo", po.status, po.expected_delivery AS "expectedDelivery",
                po.notes, po.created_at AS "createdAt", po.sent_at AS "sentAt", b.name AS "branchName"
         FROM purchase_orders po
         JOIN branches b ON b.id = po.branch_id
         WHERE po.id = $1 AND po.supplier_id = $2`,
        [poId, supplierId],
      );
      if (po.rows.length === 0) throw new NotFoundException("Purchase order not found for this supplier");
      const lines = await tx.query(
        `SELECT pl.line_no AS "lineNo", pl.variant_id AS "variantId", v.name AS "variantName",
                p.name AS "productName", pl.quantity, pl.unit_cost AS "unitCost",
                pl.received_quantity AS "receivedQuantity",
                (pl.quantity - pl.received_quantity) AS "outstandingQuantity"
         FROM purchase_order_lines pl
         JOIN product_variants v ON v.id = pl.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE pl.purchase_order_id = $1
         ORDER BY pl.line_no`,
        [poId],
      );
      return { ...po.rows[0], lines: lines.rows };
    });
  }

  /** The supplier's own price list (the cost hints that feed margins/POs). */
  async priceList(orgId: string, supplierId: string): Promise<unknown> {
    const res = await this.db.withContext(
      { orgId, userId: null, deviceId: null },
      (tx) =>
        tx.query(
        `SELECT sp.variant_id AS "variantId", sp.supplier_sku AS "supplierSku", sp.unit_cost AS "unitCost",
                sp.is_default AS "isDefault",
                v.name AS "variantName", p.name AS "productName", p.sku AS "sku"
         FROM supplier_products sp
         JOIN product_variants v ON v.id = sp.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE sp.supplier_id = $1
         ORDER BY p.name, v.name`,
          [supplierId],
        ),
    );
    return { items: res.rows };
  }

  /**
   * Phase 8: submit a delivery note against one of the supplier's POs. The
   * GRN lands as a DRAFT — the branch reviews and posts it (ledger + PO
   * receipt update happen at posting, by the stock team).
   */
  async submitDeliveryNote(
    orgId: string,
    supplierId: string,
    input: { poId?: string; lines?: { variantId: string; quantity: string }[]; notes?: string },
  ): Promise<unknown> {
    const poId = input.poId?.trim();
    if (!poId) throw new BadRequestException("poId is required");
    return this.grns.createSupplierDraft(orgId, supplierId, poId, input.lines ?? [], input.notes);
  }

  /** Supplier self-service price update — the cost hint used for margins/POs. */
  async updatePrice(supplierId: string, orgId: string, variantId: string, input: { unitCost?: string }): Promise<unknown> {
    const raw = input.unitCost;
    if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) {
      throw new BadRequestException("unitCost must be a decimal string (up to 4 dp)");
    }
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) throw new BadRequestException("unitCost must be non-negative");

    return this.db.withContext(
      { orgId, userId: null, deviceId: null },
      async (tx) => {
        const row = await tx.query(
          `UPDATE supplier_products
           SET unit_cost = $3::numeric(14,4)
           WHERE supplier_id = $1 AND variant_id = $2
           RETURNING id, variant_id AS "variantId", unit_cost AS "unitCost"`,
          [supplierId, variantId, raw],
        );
        if (row.rows.length === 0) throw new NotFoundException("This variant is not mapped to your supplier account");
        await this.audit.write(tx, "supplier.price_update", "supplier", supplierId, null, JSON.stringify({ variantId, unitCost: raw }));
        return row.rows[0];
      },
    );
  }
}

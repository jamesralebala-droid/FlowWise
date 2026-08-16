import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { assertDecimal, isUniqueViolation, requireString } from "./validate.js";

export interface CreateSupplierInput {
  name: string;
  code: string;
  contactName?: string;
  contactPhone?: string;
  email?: string;
  paymentTerms?: string;
}

export interface SupplierProductMapping {
  variantId: string;
  supplierSku?: string;
  /** decimal STRING — the supplier's unit cost (cost basis hint for GRNs) */
  unitCost?: string;
  isDefault?: boolean;
}

const SUPPLIER_COLS = `id, name, code, contact_name AS "contactName", contact_phone AS "contactPhone",
  email, payment_terms AS "paymentTerms", is_active AS "isActive",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt"`;

@Injectable()
export class SuppliersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async create(claims: JwtPayloadClaims, input: CreateSupplierInput): Promise<unknown> {
    const name = requireString(input.name, "name");
    const code = requireString(input.code, "code").toUpperCase();

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        let row;
        try {
          const r = await tx.query(
            `INSERT INTO suppliers (org_id, name, code, contact_name, contact_phone, email, payment_terms, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${SUPPLIER_COLS}`,
            [claims.org, name, code, input.contactName ?? null, input.contactPhone ?? null, input.email ?? null, input.paymentTerms ?? null, claims.sub],
          );
          row = r.rows[0];
        } catch (err) {
          if (isUniqueViolation(err)) throw new ConflictException(`A supplier with code ${code} already exists`);
          throw err;
        }
        await this.audit.write(tx, "supplier.create", "supplier", row.id, null, JSON.stringify(row));
        return row;
      },
    );
  }

  async update(claims: JwtPayloadClaims, supplierId: string, input: Partial<CreateSupplierInput>): Promise<unknown> {
    const name = input.name !== undefined ? requireString(input.name, "name") : undefined;
    const code = input.code !== undefined ? requireString(input.code, "code").toUpperCase() : undefined;

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const existing = await tx.query(`SELECT ${SUPPLIER_COLS} FROM suppliers WHERE id = $1 AND org_id = $2`, [supplierId, claims.org]);
        if (existing.rows.length === 0) throw new NotFoundException("Supplier not found");
        const old = existing.rows[0];

        let row;
        try {
          const r = await tx.query(
            `UPDATE suppliers SET
               name = COALESCE($3, name),
               code = COALESCE($4, code),
               contact_name = COALESCE($5, contact_name),
               contact_phone = COALESCE($6, contact_phone),
               email = COALESCE($7, email),
               payment_terms = COALESCE($8, payment_terms)
             WHERE id = $1 AND org_id = $2
             RETURNING ${SUPPLIER_COLS}`,
            [supplierId, claims.org, name ?? null, code ?? null, input.contactName ?? null, input.contactPhone ?? null, input.email ?? null, input.paymentTerms ?? null],
          );
          row = r.rows[0];
        } catch (err) {
          if (isUniqueViolation(err)) throw new ConflictException(`A supplier with code ${code} already exists`);
          throw err;
        }
        await this.audit.write(tx, "supplier.update", "supplier", supplierId, JSON.stringify(old), JSON.stringify(row));
        return row;
      },
    );
  }

  /** Replace-all mapping of variants to this supplier (idempotent by payload). */
  async setProducts(claims: JwtPayloadClaims, supplierId: string, products: SupplierProductMapping[]): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const sup = await tx.query("SELECT id FROM suppliers WHERE id = $1 AND org_id = $2 AND is_active", [supplierId, claims.org]);
        if (sup.rows.length === 0) throw new NotFoundException("Supplier not found");

        await tx.query("DELETE FROM supplier_products WHERE org_id = $1 AND supplier_id = $2", [claims.org, supplierId]);

        for (const [i, p] of (products ?? []).entries()) {
          const variantId = requireString(p.variantId, `products[${i}].variantId`);
          const unitCost = p.unitCost !== undefined && p.unitCost !== null ? assertDecimal(p.unitCost, `products[${i}].unitCost`, { allowZero: true }) : null;
          await tx.query(
            `INSERT INTO supplier_products (org_id, supplier_id, variant_id, supplier_sku, unit_cost, is_default)
             VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6)`,
            [claims.org, supplierId, variantId, p.supplierSku ?? null, unitCost, p.isDefault ?? false],
          );
        }

        return this.loadWithProducts(tx, claims.org, supplierId);
      },
    );
  }

  async get(claims: JwtPayloadClaims, supplierId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) => this.loadWithProducts(tx, claims.org, supplierId),
    );
  }

  async list(claims: JwtPayloadClaims): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(`SELECT ${SUPPLIER_COLS} FROM suppliers WHERE org_id = $1 ORDER BY name LIMIT 200`, [claims.org]);
        return { suppliers: r.rows };
      },
    );
  }

  private async loadWithProducts(
    tx: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> },
    orgId: string,
    supplierId: string,
  ): Promise<unknown> {
    const sup = await tx.query(`SELECT ${SUPPLIER_COLS} FROM suppliers WHERE id = $1 AND org_id = $2`, [supplierId, orgId]);
    if (sup.rows.length === 0) throw new NotFoundException("Supplier not found");
    const products = await tx.query(
      `SELECT sp.variant_id AS "variantId", sp.supplier_sku AS "supplierSku", sp.unit_cost AS "unitCost",
              sp.is_default AS "isDefault", v.name AS "variantName"
       FROM supplier_products sp
       JOIN product_variants v ON v.id = sp.variant_id
       WHERE sp.org_id = $1 AND sp.supplier_id = $2
       ORDER BY sp.created_at`,
      [orgId, supplierId],
    );
    return { ...sup.rows[0], products: products.rows };
  }
}

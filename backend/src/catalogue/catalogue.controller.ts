import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { Permissions } from "../auth/permissions.guard.js";

@Controller()
export class CatalogueController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Full catalogue pull for a branch. Only ACTIVE records are returned — the
   * device syncs just what its branch needs, never a giant org-wide dump.
   */
  @Get("catalogue")
  @Permissions("catalogue.read")
  async catalogue(@Req() req: AuthedRequest, @Query("branchId") branchId?: string) {
    const claims = req.claims;
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const [products, variants, barcodes, prices, taxes, units] = await Promise.all([
          tx.query(
            `SELECT p.id, p.name, p.sku, p.description, c.id AS "categoryId", c.name AS "categoryName",
                    u.code AS uom
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN units_of_measure u ON u.id = p.uom_id
             WHERE p.org_id = $1 AND p.is_active
             ORDER BY p.name`,
            [claims.org],
          ),
          tx.query(
            `SELECT id, product_id AS "productId", name, sku FROM product_variants
             WHERE org_id = $1 AND is_active`,
            [claims.org],
          ),
          tx.query(
            `SELECT barcode, variant_id AS "variantId" FROM barcodes
             WHERE org_id = $1 AND is_active`,
            [claims.org],
          ),
          tx.query(
            `SELECT pli.variant_id AS "variantId", pli.price
             FROM price_list_items pli
             JOIN price_lists pl ON pl.id = pli.price_list_id
             WHERE pli.org_id = $1 AND pl.is_default AND pli.valid_from IS NULL AND pli.valid_to IS NULL`,
            [claims.org],
          ),
          tx.query(`SELECT id, name, rate FROM taxes WHERE org_id = $1 AND is_active`, [claims.org]),
          tx.query(`SELECT id, code, name FROM units_of_measure WHERE org_id = $1 AND is_active`, [claims.org]),
        ]);
        return {
          branchId: branchId ?? null,
          currency: "BWP",
          products: products.rows,
          variants: variants.rows,
          barcodes: barcodes.rows,
          prices: prices.rows,
          taxes: taxes.rows,
          units: units.rows,
        };
      },
    );
  }

  /** Fast barcode → variant + price resolution (the 300ms till path). */
  @Get("barcodes/:code")
  @Permissions("catalogue.read")
  async resolveBarcode(@Req() req: AuthedRequest, @Param("code") code: string) {
    const claims = req.claims;
    const res = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) =>
        tx.query(
          `SELECT b.barcode, v.id AS "variantId", v.name AS "variantName", v.sku AS "variantSku",
                  p.id AS "productId", p.name AS "productName", p.sku AS "productSku",
                  pli.price
           FROM barcodes b
           JOIN product_variants v ON v.id = b.variant_id
           JOIN products p ON p.id = v.product_id
           LEFT JOIN price_list_items pli ON pli.variant_id = v.id AND pli.org_id = $1
           LEFT JOIN price_lists pl ON pl.id = pli.price_list_id AND pl.is_default AND pl.org_id = $1
           WHERE b.org_id = $1 AND b.barcode = $2 AND b.is_active AND v.is_active AND p.is_active
           LIMIT 1`,
          [claims.org, code],
        ),
    );
    if (res.rows.length === 0) throw new NotFoundException("Barcode not found");
    return res.rows[0];
  }
}

// ============================================================================
// FlowWise — legacy catalogue + opening-stock import (Phase 4 "data import").
//
// Runs as the MIGRATOR role (like migrations and seed:dev), inside ONE
// transaction: either the whole file applies or nothing does (Invariant 3).
// Re-running the same file is safe and idempotent:
//   - products / variants / barcodes / prices are upserted by deterministic
//     keys (sku, variant sku, barcode, price list + variant);
//   - an opening balance is written to stock_ledger ONCE per variant — the
//     ledger is append-only, so corrections after import go through the
//     normal adjustment / GRN flows, never by re-importing.
// Opening stock enters the ledger with movement_type 'opening' (migration
// 008) so inventory_items stays a pure derivation of the ledger (Invariant 2).
// ============================================================================

import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../db/migrations.js";

const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export interface ImportRow {
  sku: string;
  name: string;
  variant?: string;
  barcode?: string;
  category?: string;
  uom?: string;
  price: string;
  cost?: string;
  openingQty?: string;
}

export interface ImportOptions {
  orgSlug: string;
  branchCode: string;
  /** Price list to attach prices to; created if missing. Defaults to "Default". */
  priceList?: string;
  /** Free label attached to the opening ledger rows (e.g. the file name). */
  batchLabel?: string;
  rows: ImportRow[];
}

export interface ImportResult {
  products: number;
  variants: number;
  barcodes: number;
  prices: number;
  /** Opening stock ledger rows written. */
  openingLedgerRows: number;
  /** Rows whose opening balance already existed and were left untouched. */
  openingSkipped: number;
}

function assertDecimal(value: string, name: string, allowZero: boolean): string {
  if (!DECIMAL_RE.test(value)) throw new Error(`${name} must be a decimal string (up to 4 dp): got "${value}"`);
  const n = Number(value);
  // allowZero=true permits exactly 0 (e.g. "no opening stock"); negatives never.
  if (Number.isNaN(n) || n < 0 || (!allowZero && n === 0)) {
    throw new Error(`${name} must be ${allowZero ? "zero or" : ""} positive: got "${value}"`);
  }
  return value;
}

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    return obj;
  });
}

export async function importCatalogue(exec: SqlExecutor, opts: ImportOptions): Promise<ImportResult> {
  const org = await exec.query("SELECT id FROM organisations WHERE slug = $1", [opts.orgSlug]);
  if (org.rows.length === 0) throw new Error(`Organisation with slug "${opts.orgSlug}" not found`);
  const orgId = org.rows[0].id as string;

  const branch = await exec.query("SELECT id FROM branches WHERE org_id = $1 AND code = $2", [orgId, opts.branchCode]);
  if (branch.rows.length === 0) {
    throw new Error(`Branch with code "${opts.branchCode}" not found in organisation "${opts.orgSlug}"`);
  }
  const branchId = branch.rows[0].id as string;

  // ---- price list (created if missing; becomes default if none exists) ----
  const listName = opts.priceList?.trim() || "Default";
  let priceList = await exec.query(
    "SELECT id FROM price_lists WHERE org_id = $1 AND name = $2",
    [orgId, listName],
  );
  if (priceList.rows.length === 0) {
    await exec.query("INSERT INTO price_lists (org_id, name, currency) VALUES ($1, $2, 'BWP')", [orgId, listName]);
    priceList = await exec.query("SELECT id FROM price_lists WHERE org_id = $1 AND name = $2", [orgId, listName]);
    const defaults = await exec.query("SELECT 1 FROM price_lists WHERE org_id = $1 AND is_default", [orgId]);
    if (defaults.rows.length === 0) {
      await exec.query("UPDATE price_lists SET is_default = true WHERE id = $1", [priceList.rows[0].id]);
    }
  }
  const priceListId = priceList.rows[0].id as string;

  const importBatchId = randomUUID();
  const label = opts.batchLabel?.trim() || `import ${opts.orgSlug}`;

  const result: ImportResult = {
    products: 0,
    variants: 0,
    barcodes: 0,
    prices: 0,
    openingLedgerRows: 0,
    openingSkipped: 0,
  };

  for (const [i, raw] of opts.rows.entries()) {
    const line = i + 1; // 1-based for error messages (header is line 1)
    const sku = raw.sku;
    const name = raw.name;
    const price = raw.price;
    if (!sku) throw new Error(`line ${line}: sku is required`);
    if (!name) throw new Error(`line ${line} (sku ${sku}): name is required`);
    if (!price) throw new Error(`line ${line} (sku ${sku}): price is required`);
    assertDecimal(price, `line ${line} (sku ${sku}) price`, false);
    const cost = raw.cost ? assertDecimal(raw.cost, `line ${line} (sku ${sku}) cost`, false) : null;
    // 0 is meaningful: "no opening stock for this item" — no ledger row is written.
    const openingQty = raw.openingQty ? assertDecimal(raw.openingQty, `line ${line} (sku ${sku}) opening_qty`, true) : null;

    // ---- category / uom (created on demand, by name/code) ----
    const categoryName = raw.category?.trim() || "Imported";
    let categoryId: string | null = null;
    const cat = await exec.query(
      "SELECT id FROM categories WHERE org_id = $1 AND parent_id IS NULL AND name = $2",
      [orgId, categoryName],
    );
    if (cat.rows.length > 0) {
      categoryId = cat.rows[0].id as string;
    } else {
      const inserted = await exec.query(
        "INSERT INTO categories (org_id, name) VALUES ($1, $2) RETURNING id",
        [orgId, categoryName],
      );
      categoryId = inserted.rows[0].id as string;
    }

    const uomCode = raw.uom?.trim() || "EA";
    let uomId: string | null = null;
    const uom = await exec.query("SELECT id FROM units_of_measure WHERE org_id = $1 AND code = $2", [orgId, uomCode]);
    if (uom.rows.length > 0) {
      uomId = uom.rows[0].id as string;
    } else {
      const inserted = await exec.query(
        "INSERT INTO units_of_measure (org_id, code, name) VALUES ($1, $2, $3) RETURNING id",
        [orgId, uomCode, uomCode],
      );
      uomId = inserted.rows[0].id as string;
    }

    // ---- product (upsert by org+sku) ----
    let product = await exec.query("SELECT id FROM products WHERE org_id = $1 AND sku = $2", [orgId, sku]);
    if (product.rows.length === 0) {
      const inserted = await exec.query(
        "INSERT INTO products (org_id, category_id, uom_id, name, sku) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [orgId, categoryId, uomId, name, sku],
      );
      product = { rows: [{ id: inserted.rows[0].id }] };
      result.products += 1;
    } else {
      await exec.query("UPDATE products SET name = $1, category_id = $2, uom_id = $3 WHERE id = $4", [
        name,
        categoryId,
        uomId,
        product.rows[0].id,
      ]);
    }
    const productId = product.rows[0].id as string;

    // ---- variant (upsert by deterministic variant sku) ----
    const variantName = raw.variant?.trim() || "Default";
    // Deterministic across re-runs so re-importing a file is a no-op, never a duplicate.
    const variantSku = variantName === "Default" ? sku : `${sku}#${variantName}`;
    let variant = await exec.query("SELECT id FROM product_variants WHERE org_id = $1 AND sku = $2", [orgId, variantSku]);
    if (variant.rows.length === 0) {
      const inserted = await exec.query(
        "INSERT INTO product_variants (org_id, product_id, name, sku) VALUES ($1, $2, $3, $4) RETURNING id",
        [orgId, productId, variantName, variantSku],
      );
      variant = { rows: [{ id: inserted.rows[0].id }] };
      result.variants += 1;
    } else {
      await exec.query("UPDATE product_variants SET name = $1, product_id = $2 WHERE id = $3", [
        variantName,
        productId,
        variant.rows[0].id,
      ]);
    }
    const variantId = variant.rows[0].id as string;

    // ---- barcode (reject reassignment; never silently re-point) ----
    if (raw.barcode) {
      const existing = await exec.query("SELECT variant_id FROM barcodes WHERE org_id = $1 AND barcode = $2", [
        orgId,
        raw.barcode,
      ]);
      if (existing.rows.length > 0) {
        if (existing.rows[0].variant_id !== variantId) {
          throw new Error(
            `line ${line} (sku ${sku}): barcode "${raw.barcode}" is already assigned to a different variant`,
          );
        }
      } else {
        await exec.query("INSERT INTO barcodes (org_id, variant_id, barcode) VALUES ($1, $2, $3)", [
          orgId,
          variantId,
          raw.barcode,
        ]);
        result.barcodes += 1;
      }
    }

    // ---- price (upsert per price list + variant) ----
    await exec.query(
      `INSERT INTO price_list_items (org_id, price_list_id, variant_id, price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, price_list_id, variant_id)
       DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [orgId, priceListId, variantId, price],
    );
    result.prices += 1;

    // ---- opening balance (ledger, once per variant — Invariants 1 & 2) ----
    if (openingQty && Number(openingQty) > 0) {
      const already = await exec.query(
        `SELECT 1 FROM stock_ledger
         WHERE org_id = $1 AND reference_type = 'import' AND movement_type = 'opening' AND variant_id = $2`,
        [orgId, variantId],
      );
      if (already.rows.length > 0) {
        result.openingSkipped += 1;
        continue;
      }
      await exec.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, idempotency_key, notes)
         VALUES ($1, $2, $3, 'opening', $4::numeric(14,4), $5::numeric(14,4),
                 'import', $6, $7, $8)`,
        [
          orgId,
          branchId,
          variantId,
          openingQty,
          cost,
          importBatchId,
          `import:opening:${variantId}`,
          `${label} (line ${line})`,
        ],
      );
      result.openingLedgerRows += 1;
    }
  }

  return result;
}

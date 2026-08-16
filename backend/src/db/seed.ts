// ============================================================================
// FlowWise — demo seed (dev/training/pilot data). Exported as a pure function
// over a SqlExecutor so the CLI (`seed:dev`) and the PGlite smoke test share
// the exact same code path.
//
// What it builds for the `botwise-demo` organisation:
//   * two branches (MAIN, PHK) — branch-scoped RBAC demo
//   * categories, UOMs, taxes, one default BWP price list
//   * a realistic Botswana retail catalogue (~16 items) with barcodes,
//     prices/costs, supplier mappings
//   * opening balances written to stock_ledger (movement_type 'opening') so
//     inventory_items stays a pure derivation of the ledger (Invariants 1 & 2)
//   * per-branch reorder rules — deliberately includes an item below its
//     reorder point so the first reorder evaluation shows live suggestions
//   * six demo users (owner / branch manager / cashier ×2 / stock controller /
//     auditor) with per-branch role assignments
//   * the `flowwise-app` OAuth public client
//
// Everything is idempotent: re-running the seed never duplicates products,
// prices, ledger rows, rules, or role assignments.
// ============================================================================

import type { SqlExecutor } from "./migrations.js";

export interface DemoSeedResult {
  orgId: string;
  branches: { code: string; name: string; id: string }[];
  products: number;
  variants: number;
  barcodes: number;
  prices: number;
  suppliers: number;
  openingLedgerRows: number;
  reorderRules: number;
  users: number;
  customers: number;
  customerOpeningRows: number;
  promotions: number;
}

interface BranchStock {
  opening: string;
  reorderPoint: string;
  reorderQty: string;
}

interface CatalogueItem {
  sku: string;
  name: string;
  variant: string;
  barcode: string;
  category: string;
  uom: string;
  /** Selling price in BWP (default price list). */
  price: string;
  /** Unit cost in BWP (opening ledger rows + supplier mapping). */
  cost: string;
  /** Supplier code (see SUPPLIERS). */
  supplier: string;
  leadTimeDays: number;
  safetyStockDays: number;
  stock: Record<string, BranchStock>;
}

const ORG_SLUG = "botwise-demo";
const ORG_NAME = "BotWise Demo";
const PRICE_LIST = "Default";

const BRANCHES = [
  { code: "MAIN", name: "Main Branch (Gaborone CBD)" },
  { code: "PHK", name: "Phakalane Branch" },
];

const CATEGORIES = ["Beverages", "Groceries", "Household", "Personal Care", "Snacks"];
const UOMS = ["EA", "BOX", "KG", "L", "CARTON"];

const SUPPLIERS = [
  { code: "SEFALANA", name: "Sefalana Cash & Carry", contact: "+267 390 1234", terms: "30 days" },
  { code: "CHOPPIES", name: "Choppies Wholesale", contact: "+267 395 5678", terms: "30 days" },
  { code: "BBV", name: "B&B Beverage Distributors", contact: "+267 371 9012", terms: "14 days" },
  { code: "FRESHMARK", name: "FreshMark Foods", contact: "+267 316 3456", terms: "7 days" },
];

// BWP prices are plausible 2026 retail levels for a Gaborone SME shelf.
const CATALOGUE: CatalogueItem[] = [
  { sku: "BEV-001", name: "Coca-Cola 330ml can", variant: "can", barcode: "6001100570303", category: "Beverages", uom: "EA", price: "8.50", cost: "6.20", supplier: "BBV", leadTimeDays: 2, safetyStockDays: 3,
    stock: { MAIN: { opening: "240", reorderPoint: "60", reorderQty: "144" }, PHK: { opening: "96", reorderPoint: "36", reorderQty: "72" } } },
  { sku: "BEV-002", name: "Fanta Orange 330ml can", variant: "can", barcode: "6001100570402", category: "Beverages", uom: "EA", price: "8.50", cost: "6.20", supplier: "BBV", leadTimeDays: 2, safetyStockDays: 3,
    stock: { MAIN: { opening: "200", reorderPoint: "50", reorderQty: "120" }, PHK: { opening: "84", reorderPoint: "30", reorderQty: "60" } } },
  { sku: "BEV-003", name: "Sprite 330ml can", variant: "can", barcode: "6001100570501", category: "Beverages", uom: "EA", price: "8.50", cost: "6.20", supplier: "BBV", leadTimeDays: 2, safetyStockDays: 3,
    stock: { MAIN: { opening: "180", reorderPoint: "50", reorderQty: "120" }, PHK: { opening: "72", reorderPoint: "30", reorderQty: "60" } } },
  { sku: "BEV-004", name: "Still Water 5L bottle", variant: "5L", barcode: "6001100570600", category: "Beverages", uom: "EA", price: "30.00", cost: "22.50", supplier: "BBV", leadTimeDays: 2, safetyStockDays: 3,
    stock: { MAIN: { opening: "60", reorderPoint: "20", reorderQty: "48" }, PHK: { opening: "30", reorderPoint: "12", reorderQty: "24" } } },
  // Deliberately below its reorder point on MAIN so the first reorder
  // evaluation produces a live suggestion for the demo/pilot.
  { sku: "GRO-001", name: "White Maize Meal 12.5kg", variant: "12.5kg", barcode: "6009606100617", category: "Groceries", uom: "EA", price: "89.50", cost: "76.00", supplier: "FRESHMARK", leadTimeDays: 3, safetyStockDays: 4,
    stock: { MAIN: { opening: "18", reorderPoint: "40", reorderQty: "60" }, PHK: { opening: "25", reorderPoint: "20", reorderQty: "40" } } },
  { sku: "GRO-002", name: "Long Grain Rice 5kg", variant: "5kg", barcode: "6009606100624", category: "Groceries", uom: "EA", price: "74.00", cost: "62.00", supplier: "FRESHMARK", leadTimeDays: 3, safetyStockDays: 4,
    stock: { MAIN: { opening: "32", reorderPoint: "15", reorderQty: "40" }, PHK: { opening: "18", reorderPoint: "10", reorderQty: "24" } } },
  { sku: "GRO-003", name: "White Sugar 2.5kg", variant: "2.5kg", barcode: "6009606100631", category: "Groceries", uom: "EA", price: "42.50", cost: "36.00", supplier: "FRESHMARK", leadTimeDays: 3, safetyStockDays: 4,
    stock: { MAIN: { opening: "44", reorderPoint: "20", reorderQty: "48" }, PHK: { opening: "22", reorderPoint: "12", reorderQty: "24" } } },
  { sku: "GRO-004", name: "Cooking Oil 2L", variant: "2L", barcode: "6009606100648", category: "Groceries", uom: "EA", price: "78.00", cost: "66.50", supplier: "FRESHMARK", leadTimeDays: 3, safetyStockDays: 4,
    stock: { MAIN: { opening: "28", reorderPoint: "15", reorderQty: "36" }, PHK: { opening: "14", reorderPoint: "8", reorderQty: "24" } } },
  { sku: "GRO-005", name: "Long-Life Milk 1L", variant: "1L", barcode: "6009606100655", category: "Groceries", uom: "EA", price: "21.00", cost: "17.00", supplier: "FRESHMARK", leadTimeDays: 2, safetyStockDays: 3,
    stock: { MAIN: { opening: "72", reorderPoint: "30", reorderQty: "96" }, PHK: { opening: "36", reorderPoint: "15", reorderQty: "48" } } },
  { sku: "GRO-006", name: "Black Tea Bags 100 pack", variant: "100s", barcode: "6009606100662", category: "Groceries", uom: "EA", price: "45.00", cost: "38.00", supplier: "CHOPPIES", leadTimeDays: 4, safetyStockDays: 5,
    stock: { MAIN: { opening: "25", reorderPoint: "10", reorderQty: "24" }, PHK: { opening: "12", reorderPoint: "6", reorderQty: "12" } } },
  { sku: "GRO-007", name: "Peanut Butter 500g", variant: "500g", barcode: "6009606100679", category: "Groceries", uom: "EA", price: "39.00", cost: "32.50", supplier: "CHOPPIES", leadTimeDays: 4, safetyStockDays: 5,
    stock: { MAIN: { opening: "20", reorderPoint: "8", reorderQty: "24" }, PHK: { opening: "10", reorderPoint: "5", reorderQty: "12" } } },
  { sku: "GRO-008", name: "Iodised Salt 1kg", variant: "1kg", barcode: "6009606100686", category: "Groceries", uom: "EA", price: "9.50", cost: "7.00", supplier: "FRESHMARK", leadTimeDays: 3, safetyStockDays: 4,
    stock: { MAIN: { opening: "80", reorderPoint: "30", reorderQty: "60" }, PHK: { opening: "40", reorderPoint: "20", reorderQty: "36" } } },
  { sku: "PCE-001", name: "Bath Soap 125g", variant: "125g", barcode: "6009606100693", category: "Personal Care", uom: "EA", price: "12.00", cost: "9.20", supplier: "CHOPPIES", leadTimeDays: 4, safetyStockDays: 5,
    stock: { MAIN: { opening: "120", reorderPoint: "40", reorderQty: "96" }, PHK: { opening: "60", reorderPoint: "24", reorderQty: "48" } } },
  { sku: "HSH-001", name: "Toilet Paper 9 rolls", variant: "9-roll", barcode: "6009606100709", category: "Household", uom: "EA", price: "55.00", cost: "46.00", supplier: "CHOPPIES", leadTimeDays: 4, safetyStockDays: 5,
    stock: { MAIN: { opening: "36", reorderPoint: "12", reorderQty: "36" }, PHK: { opening: "18", reorderPoint: "8", reorderQty: "24" } } },
  { sku: "HSH-002", name: "Dishwashing Liquid 500ml", variant: "500ml", barcode: "6009606100716", category: "Household", uom: "EA", price: "33.00", cost: "27.00", supplier: "CHOPPIES", leadTimeDays: 4, safetyStockDays: 5,
    stock: { MAIN: { opening: "30", reorderPoint: "12", reorderQty: "24" }, PHK: { opening: "15", reorderPoint: "6", reorderQty: "12" } } },
  { sku: "SNK-001", name: "Potato Chips 40g", variant: "40g", barcode: "6009606100723", category: "Snacks", uom: "EA", price: "7.00", cost: "5.10", supplier: "SEFALANA", leadTimeDays: 3, safetyStockDays: 3,
    stock: { MAIN: { opening: "150", reorderPoint: "50", reorderQty: "120" }, PHK: { opening: "60", reorderPoint: "24", reorderQty: "60" } } },
];

// email → (name, assignments). branchId null = org-wide.
interface SeedUser {
  email: string;
  name: string;
  assignments: { role: string; branch: string | null }[];
}

const USERS: SeedUser[] = [
  { email: "owner@flowwise.demo", name: "Demo Owner", assignments: [{ role: "owner", branch: null }] },
  { email: "manager@flowwise.demo", name: "Demo Branch Manager", assignments: [{ role: "branch_manager", branch: "MAIN" }, { role: "branch_manager", branch: "PHK" }] },
  { email: "cashier@flowwise.demo", name: "Demo Cashier", assignments: [{ role: "cashier", branch: "MAIN" }] },
  { email: "cashier2@flowwise.demo", name: "Demo Cashier (PHK)", assignments: [{ role: "cashier", branch: "PHK" }] },
  { email: "stock@flowwise.demo", name: "Demo Stock Controller", assignments: [{ role: "stock_controller", branch: "MAIN" }, { role: "stock_controller", branch: "PHK" }] },
  { email: "auditor@flowwise.demo", name: "Demo Auditor", assignments: [{ role: "auditor", branch: null }] },
];

// Phase 5 demo customers: one account with a credit limit and a receivable
// (so statements and settlements are demo-able), one cash-only walk-in.
const CUSTOMERS = [
  {
    email: "accounts@maunlodge.test",
    name: "Maun Lodge Supplies",
    phone: "+267 76 123 456",
    creditLimit: "5000",
    openingBalance: "850",
  },
  {
    email: "kelebogile@example.test",
    name: "Mma Kelebogile",
    phone: "+267 71 654 321",
    creditLimit: "0",
    openingBalance: null,
  },
];

async function insertReturningId(exec: SqlExecutor, sql: string, params: unknown[]): Promise<string | null> {
  const r = await exec.query(sql, params);
  return (r.rows[0]?.id as string) ?? null;
}

export async function seedDemoData(exec: SqlExecutor, passwordHash: string): Promise<DemoSeedResult> {
  // ---- organisation -------------------------------------------------------
  const org = await exec.query(
    `INSERT INTO organisations (name, slug, currency_code, timezone, vat_rate)
     VALUES ($1, $2, 'BWP', 'Africa/Gaborone', 0.1400)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [ORG_NAME, ORG_SLUG],
  );
  const orgId = org.rows[0].id as string;

  // ---- branches ------------------------------------------------------------
  const branches: { code: string; name: string; id: string }[] = [];
  for (const b of BRANCHES) {
    const id = await insertReturningId(
      exec,
      `INSERT INTO branches (org_id, name, code)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, b.name, b.code],
    );
    branches.push({ ...b, id: id! });
  }
  const branchIdByCode = Object.fromEntries(branches.map((b) => [b.code, b.id]));

  // ---- catalogue scaffolding ----------------------------------------------
  // Categories are select-then-insert: the (org, parent, name) unique index
  // treats NULL parent as distinct, so ON CONFLICT would duplicate top-level
  // rows on re-runs (same pattern as the CSV import service).
  for (const name of CATEGORIES) {
    const existing = await exec.query(
      `SELECT id FROM categories WHERE org_id = $1 AND parent_id IS NULL AND name = $2`,
      [orgId, name],
    );
    if (existing.rows.length === 0) {
      await exec.query(`INSERT INTO categories (org_id, parent_id, name) VALUES ($1, NULL, $2)`, [orgId, name]);
    }
  }
  for (const code of UOMS) {
    await exec.query(
      `INSERT INTO units_of_measure (org_id, code, name) VALUES ($1, $2, $2)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, code],
    );
  }
  await exec.query(
    `INSERT INTO taxes (org_id, name, rate) VALUES ($1, 'VAT 14%', 0.1400), ($1, 'Zero-rated', 0)
     ON CONFLICT (org_id, name) DO NOTHING`,
    [orgId],
  );

  // ---- suppliers ------------------------------------------------------------
  for (const s of SUPPLIERS) {
    await exec.query(
      `INSERT INTO suppliers (org_id, name, code, contact_name, contact_phone, payment_terms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [orgId, s.name, s.code, s.contact, s.contact, s.terms],
    );
  }

  const priceListId = await insertReturningId(
    exec,
    `INSERT INTO price_lists (org_id, name, is_default, currency)
     VALUES ($1, $2, true, 'BWP')
     ON CONFLICT (org_id, name) DO UPDATE SET is_default = true
     RETURNING id`,
    [orgId, PRICE_LIST],
  );

  const result: DemoSeedResult = {
    orgId,
    branches,
    products: 0,
    variants: 0,
    barcodes: 0,
    prices: 0,
    suppliers: SUPPLIERS.length,
    openingLedgerRows: 0,
    reorderRules: 0,
    users: 0,
    customers: 0,
    customerOpeningRows: 0,
    promotions: 0,
  };

  // ---- catalogue + opening stock + reorder rules ---------------------------
  for (const item of CATALOGUE) {
    const categoryId = await insertReturningId(
      exec,
      `SELECT id FROM categories WHERE org_id = $1 AND parent_id IS NULL AND name = $2`,
      [orgId, item.category],
    );
    const uomId = await insertReturningId(
      exec,
      `SELECT id FROM units_of_measure WHERE org_id = $1 AND code = $2`,
      [orgId, item.uom],
    );
    const supplierId = await insertReturningId(
      exec,
      `SELECT id FROM suppliers WHERE org_id = $1 AND code = $2`,
      [orgId, item.supplier],
    );

    // product + variant — select-then-insert: the (org, sku) unique indexes are
    // PARTIAL (WHERE sku IS NOT NULL), which ON CONFLICT cannot target, and
    // select-then-insert keeps re-runs idempotent (same as the import service).
    const productId =
      (await insertReturningId(exec, `SELECT id FROM products WHERE org_id = $1 AND sku = $2`, [orgId, item.sku])) ??
      (await insertReturningId(
        exec,
        `INSERT INTO products (org_id, category_id, uom_id, name, sku)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [orgId, categoryId, uomId, item.name, item.sku],
      ))!;
    result.products += 1;

    // Variant reorder defaults mirror the MAIN branch so variant-level
    // low-stock alerts are meaningful before any per-branch rule exists.
    const mainStock = item.stock["MAIN"]!;
    const variantId =
      (await insertReturningId(exec, `SELECT id FROM product_variants WHERE org_id = $1 AND sku = $2`, [orgId, item.sku])) ??
      (await insertReturningId(
        exec,
        `INSERT INTO product_variants (org_id, product_id, name, sku, reorder_level, reorder_quantity)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric)
         RETURNING id`,
        [orgId, productId, item.variant, item.sku, mainStock.reorderPoint, mainStock.reorderQty],
      ))!;
    result.variants += 1;

    await exec.query(
      `INSERT INTO barcodes (org_id, variant_id, barcode) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, barcode) DO NOTHING`,
      [orgId, variantId, item.barcode],
    );
    result.barcodes += 1;

    await exec.query(
      `INSERT INTO price_list_items (org_id, price_list_id, variant_id, price)
       VALUES ($1, $2, $3, $4::numeric)
       ON CONFLICT (org_id, price_list_id, variant_id)
       DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [orgId, priceListId, variantId, item.price],
    );
    result.prices += 1;

    await exec.query(
      `INSERT INTO supplier_products (org_id, supplier_id, variant_id, supplier_sku, unit_cost, is_default)
       VALUES ($1, $2, $3, $4, $5::numeric, true)
       ON CONFLICT (org_id, supplier_id, variant_id)
       DO UPDATE SET unit_cost = EXCLUDED.unit_cost, supplier_sku = EXCLUDED.supplier_sku`,
      [orgId, supplierId, variantId, item.sku, item.cost],
    );

    // opening balances + reorder rules, per branch (ledger-backed, idempotent)
    for (const branch of BRANCHES) {
      const s = item.stock[branch.code];
      if (!s) continue;

      const insertedOpening = await exec.query(
        `INSERT INTO stock_ledger
           (org_id, branch_id, variant_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, idempotency_key, notes)
         VALUES ($1, $2, $3, 'opening', $4::numeric, $5::numeric,
                 'seed', $6::uuid, $7, $8)
         ON CONFLICT (org_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          orgId,
          branchIdByCode[branch.code],
          variantId,
          s.opening,
          item.cost,
          orgId,
          `seed:opening:${branch.code}:${item.sku}`,
          `Seed opening balance — ${item.name} @ ${branch.code}`,
        ],
      );
      result.openingLedgerRows += insertedOpening.rows.length;

      await exec.query(
        `INSERT INTO reorder_rules
           (org_id, branch_id, variant_id, reorder_point, reorder_quantity,
            lead_time_days, safety_stock_days, demand_window_days, is_active)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, 30, true)
         ON CONFLICT (org_id, branch_id, variant_id)
         DO UPDATE SET reorder_point = EXCLUDED.reorder_point,
                       reorder_quantity = EXCLUDED.reorder_quantity,
                       lead_time_days = EXCLUDED.lead_time_days,
                       safety_stock_days = EXCLUDED.safety_stock_days`,
        [orgId, branchIdByCode[branch.code], variantId, s.reorderPoint, s.reorderQty, item.leadTimeDays, item.safetyStockDays],
      );
      result.reorderRules += 1;
    }
  }

  // ---- users + per-branch role assignments ---------------------------------
  for (const u of USERS) {
    const userId = await insertReturningId(
      exec,
      `INSERT INTO users (org_id, email, name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, u.email, u.name, passwordHash],
    );
    if (userId) result.users += 1;

    for (const a of u.assignments) {
      // NOT EXISTS guard: (org,user,branch,role) with branch NULL is NOT
      // deduped by the UNIQUE index (NULLs are distinct), so check explicitly.
      await exec.query(
        `INSERT INTO user_role_assignments (org_id, user_id, branch_id, role_code)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (
           SELECT 1 FROM user_role_assignments
           WHERE org_id = $1 AND user_id = $2
             AND branch_id IS NOT DISTINCT FROM $3 AND role_code = $4
         )`,
        [orgId, userId, a.branch ? branchIdByCode[a.branch] : null, a.role],
      );
    }
  }

  // ---- Phase 6 demo promotions (idempotent by code) -------------------------
  const PROMOTIONS: {
    code: string;
    name: string;
    discountType: "percentage" | "amount";
    discountValue: string;
    minSpend: string;
    usageLimit?: number | null;
  }[] = [
    { code: "WELCOME10", name: "10% off your basket", discountType: "percentage", discountValue: "0.10", minSpend: "50" },
    { code: "P50OFF", name: "P50 off orders over P200", discountType: "amount", discountValue: "50", minSpend: "200" },
    { code: "MONTHEND5", name: "Month-end 5% (100 uses)", discountType: "percentage", discountValue: "0.05", minSpend: "0", usageLimit: 100 },
  ];
  for (const p of PROMOTIONS) {
    const inserted = await exec.query(
      `INSERT INTO promotions (org_id, code, name, discount_type, discount_value, min_spend, usage_limit)
       VALUES ($1, $2, $3, $4, $5::numeric(14,4), $6::numeric(14,4), $7)
       ON CONFLICT (org_id, lower(code)) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, p.code, p.name, p.discountType, p.discountValue, p.minSpend, p.usageLimit ?? null],
    );
    result.promotions += inserted.rows.length;
  }

  // ---- OAuth public client --------------------------------------------------
  await exec.query(
    `INSERT INTO oauth_clients (client_id, name, redirect_uris)
     VALUES ('flowwise-app', 'FlowWise Android', '[]'::jsonb)
     ON CONFLICT (client_id) DO NOTHING`,
  );

  // ---- Phase 5 demo customers + opening receivables --------------------------
  const ownerRow = await exec.query(
    `SELECT id FROM users WHERE org_id = $1 AND email = 'owner@flowwise.demo' LIMIT 1`,
    [orgId],
  );
  const ownerUserId = (ownerRow.rows[0]?.id as string) ?? null;

  for (const c of CUSTOMERS) {
    const customerId =
      (await insertReturningId(exec, `SELECT id FROM customers WHERE org_id = $1 AND lower(trim(email)) = $2`, [orgId, c.email])) ??
      (await insertReturningId(
        exec,
        `INSERT INTO customers (org_id, name, phone, email, credit_limit)
         VALUES ($1, $2, $3, $4, $5::numeric(14,4))
         RETURNING id`,
        [orgId, c.name, c.phone, c.email, c.creditLimit],
      ))!;
    result.customers += 1;

    if (c.openingBalance) {
      // Opening receivable enters the append-only customer ledger exactly once
      // (idempotency key); the balance view derives from it like everywhere.
      const inserted = await exec.query(
        `INSERT INTO customer_ledger
           (org_id, customer_id, branch_id, entry_type, amount, reference_type, notes,
            client_operation_id, business_time, created_by_user_id)
         VALUES ($1, $2, $3, 'adjustment', $4::numeric(14,4), 'seed', 'Seed opening balance',
                 $5, now(), $6)
         ON CONFLICT (org_id, customer_id, client_operation_id)
         WHERE client_operation_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [orgId, customerId, branchIdByCode["MAIN"], c.openingBalance, `seed:customer:opening:${c.email}`, ownerUserId],
      );
      result.customerOpeningRows += inserted.rows.length;
    }
  }

  return result;
}

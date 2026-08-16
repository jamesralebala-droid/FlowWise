import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, type Row, type SqlExecutor } from "../src/db/migrations.js";
import { importCatalogue, parseCsv, type ImportRow } from "../src/import/import-catalogue.js";

const CSV = [
  "sku,name,variant,barcode,category,uom,price,cost,opening_qty",
  "SKU-100,Coca-Cola 330ml,,6001000000001,Drinks,EA,7.50,5.00,120",
  "SKU-101,\"Fanta, Orange\",330ml,6001000000002,Drinks,EA,7.50,5.00,48",
  "SKU-102,Maize Meal 12.5kg,,6001000000003,Groceries,EA,89.00,75.00,10",
  "SKU-103,Water 500ml,Multi-pack,6001000000004,Drinks,EA,36.00,30.00,0",
].join("\r\n");

function rows(csv: string): ImportRow[] {
  return parseCsv(csv).map((r) => ({
    sku: r.sku ?? "",
    name: r.name ?? "",
    variant: r.variant || undefined,
    barcode: r.barcode || undefined,
    category: r.category || undefined,
    uom: r.uom || undefined,
    price: r.price ?? "",
    cost: r.cost || undefined,
    openingQty: r.opening_qty || undefined,
  }));
}

describe("catalogue + opening-stock CSV import (Phase 4 data import)", () => {
  let raw: PGlite;
  let exec: SqlExecutor;
  let orgIds: Record<string, string>;

  beforeAll(async () => {
    raw = new PGlite();
    exec = {
      exec: (sql) => raw.exec(sql),
      query: async (text, params) => {
        const r = await raw.query<Row>(text, params ?? []);
        return { rows: r.rows };
      },
    };
    await runMigrations(exec);

    // Each test gets its own org so tests never share state (one PGlite boot
    // for the whole file keeps the sandbox well under memory limits).
    orgIds = {};
    for (const slug of ["acme", "acme-replay", "acme-bad", "acme-dup"]) {
      await raw.exec(`INSERT INTO organisations (name, slug) VALUES ('${slug}', '${slug}') RETURNING id`);
      await raw.exec(`INSERT INTO branches (org_id, name, code) SELECT id, 'Main Branch', 'MAIN' FROM organisations WHERE slug = '${slug}'`);
      const r = await raw.query<Row>(`SELECT id FROM organisations WHERE slug = '${slug}'`);
      orgIds[slug] = r.rows[0].id as string;
    }
  });
  afterAll(async () => {
    await raw.close();
  });

  async function q(sql: string, params?: unknown[]): Promise<Row[]> {
    const r = await raw.query<Row>(sql, params ?? []);
    return r.rows;
  }

  /** Run importCatalogue inside one PGlite transaction (the CLI's contract). */
  async function runImport(opts: Parameters<typeof importCatalogue>[1]): Promise<ReturnType<typeof importCatalogue>> {
    // PGlite rolls back automatically when the callback throws.
    return raw.transaction(async (tx) => {
      const txExec: SqlExecutor = {
        exec: (sql) => tx.exec(sql),
        query: async (text, params) => {
          const r = await tx.query<Row>(text, params ?? []);
          return { rows: r.rows };
        },
      };
      return importCatalogue(txExec, opts);
    });
  }

  it("imports catalogue and writes opening balances through the ledger (delta = 0)", async () => {
    const result = await runImport({
      orgSlug: "acme",
      branchCode: "MAIN",
      batchLabel: "catalogue.csv",
      rows: rows(CSV),
    });

    expect(result.products).toBe(4);
    expect(result.variants).toBe(4);
    expect(result.barcodes).toBe(4);
    expect(result.prices).toBe(4);
    expect(result.openingLedgerRows).toBe(3); // SKU-103 has opening_qty 0
    expect(result.openingSkipped).toBe(0);

    // Catalogue upserted with the expected price on the default price list.
    const price = await q(
      `SELECT pli.price FROM price_list_items pli
       JOIN price_lists pl ON pl.id = pli.price_list_id
       JOIN product_variants v ON v.id = pli.variant_id
       WHERE v.sku = 'SKU-100' AND pl.is_default`,
    );
    expect(price[0].price).toBe("7.5000");

    // Barcode → variant mapping (deterministic variant sku for non-default variants).
    const barcode = await q(
      `SELECT v.sku FROM barcodes b JOIN product_variants v ON v.id = b.variant_id WHERE b.barcode = '6001000000004'`,
    );
    expect(barcode[0].sku).toBe("SKU-103#Multi-pack");

    // Opening balances live in the ledger, and the derived cache reconciles.
    const reconciles = await q(
      `SELECT variant_id, ledger_quantity, inventory_quantity, delta
       FROM v_stock_reconciliation WHERE org_id = $1`,
      [orgIds["acme"]],
    );
    expect(reconciles).toHaveLength(3);
    for (const r of reconciles) {
      expect(r.delta).toBe("0.0000");
    }
    const totals = reconciles.map((r) => r.ledger_quantity as string).sort();
    expect(totals).toEqual(["10.0000", "120.0000", "48.0000"].sort());
  });

  it("re-importing the same file is a no-op — no duplicates, opening balances preserved", async () => {
    const opts = { orgSlug: "acme-replay", branchCode: "MAIN", batchLabel: "catalogue.csv", rows: rows(CSV) };
    await runImport(opts);
    const replay = await runImport(opts);

    expect(replay.products).toBe(0);
    expect(replay.variants).toBe(0);
    expect(replay.openingLedgerRows).toBe(0);
    expect(replay.openingSkipped).toBe(3);

    const productCount = await q(`SELECT count(*)::int AS n FROM products WHERE org_id = $1`, [orgIds["acme-replay"]]);
    const ledgerCount = await q(
      `SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1 AND movement_type = 'opening'`,
      [orgIds["acme-replay"]],
    );
    expect(productCount[0].n).toBe(4);
    expect(ledgerCount[0].n).toBe(3);
  });

  it("a single bad row rejects the whole file (atomicity — nothing half-applied)", async () => {
    const bad = [
      "sku,name,price,opening_qty",
      "SKU-200,Rice 5kg,55.00,20",
      "SKU-201,Sugar 1kg,,10", // missing price
    ].join("\n");

    await expect(runImport({ orgSlug: "acme-bad", branchCode: "MAIN", rows: rows(bad) })).rejects.toThrow(
      /price is required/,
    );

    const productCount = await q(`SELECT count(*)::int AS n FROM products WHERE org_id = $1`, [orgIds["acme-bad"]]);
    const ledgerCount = await q(`SELECT count(*)::int AS n FROM stock_ledger WHERE org_id = $1`, [orgIds["acme-bad"]]);
    expect(productCount[0].n).toBe(0);
    expect(ledgerCount[0].n).toBe(0);
  });

  it("rejects a barcode already assigned to another variant", async () => {
    const dup = [
      "sku,name,barcode,price",
      "SKU-300,Item A,6009999999999,10.00",
      "SKU-301,Item B,6009999999999,20.00",
    ].join("\n");
    await expect(runImport({ orgSlug: "acme-dup", branchCode: "MAIN", rows: rows(dup) })).rejects.toThrow(
      /already assigned to a different variant/,
    );
    const productCount = await q(`SELECT count(*)::int AS n FROM products WHERE org_id = $1`, [orgIds["acme-dup"]]);
    expect(productCount[0].n).toBe(0);
  });

  it("parses quoted fields, embedded commas and CRLF line endings", () => {
    const parsed = parseCsv(CSV);
    expect(parsed).toHaveLength(4);
    expect(parsed[1].name).toBe("Fanta, Orange");
    expect(parsed[1].variant).toBe("330ml");
    expect(parsed[0].sku).toBe("SKU-100");
  });
});

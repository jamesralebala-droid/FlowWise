// FlowWise — CLI: legacy catalogue + opening-stock CSV import.
//
//   DATABASE_URL=postgres://... bun run import:catalogue --file catalogue.csv \
//       --org botwise-demo --branch MAIN [--price-list "Default"]
//
// Runs as the migrator role against a real PostgreSQL (same role contract as
// `migrate` and `seed:dev`). The whole file is applied in ONE transaction.
//
// CSV columns (header row required, case-insensitive):
//   sku, name, variant, barcode, category, uom, price, cost, opening_qty
// Only sku, name and price are required. Re-running the same file is safe:
// catalogue rows upsert, opening balances are written once (see
// import-catalogue.ts for the invariant rationale).

import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { env } from "../env.js";
import { importCatalogue, parseCsv, type ImportRow } from "./import-catalogue.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    console.error("import:catalogue requires DATABASE_URL (run it against your PostgreSQL as the migrator role).");
    process.exit(1);
  }
  const file = arg("file");
  const orgSlug = arg("org");
  const branchCode = arg("branch");
  if (!file || !orgSlug || !branchCode) {
    console.error(
      "usage: import:catalogue --file catalogue.csv --org <slug> --branch <code> [--price-list <name>]",
    );
    process.exit(1);
  }

  const raw = await readFile(file, "utf8");
  const parsed = parseCsv(raw);
  if (parsed.length === 0) {
    console.error("no data rows found in CSV (expected a header row: sku,name,variant,barcode,category,uom,price,cost,opening_qty)");
    process.exit(1);
  }
  const rows: ImportRow[] = parsed.map((r) => ({
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

  const pool = new Pool({ connectionString: env.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importCatalogue(
      {
        exec: (sql) => client.query(sql),
        query: (text, params) => client.query(text, params),
      },
      { orgSlug, branchCode, priceList: arg("price-list"), batchLabel: file, rows },
    );
    await client.query("COMMIT");
    console.log(
      `Imported ${rows.length} rows into "${orgSlug}" (branch ${branchCode}):\n` +
        `  products: ${result.products} new, variants: ${result.variants} new,\n` +
        `  barcodes: ${result.barcodes} new, prices: ${result.prices} upserted,\n` +
        `  opening ledger rows: ${result.openingLedgerRows} written, ${result.openingSkipped} already set (skipped).`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`import failed — nothing was applied:\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();

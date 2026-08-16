import { Pool } from "pg";
import type { PGlite } from "@electric-sql/pglite";
import { runMigrations, type SqlExecutor } from "./migrations.js";

export interface Row {
  [k: string]: any;
}

export interface DbResult {
  rows: Row[];
  rowCount: number | null;
}

/** A transaction-scoped executor. Every query runs inside BEGIN/COMMIT with the tenant GUCs applied. */
export interface DbExecutor {
  query(text: string, params?: unknown[]): Promise<DbResult>;
  exec(sql: string): Promise<void>;
}

export interface DbContext {
  orgId: string;
  userId?: string | null;
  deviceId?: string | null;
}

export interface Db {
  /** Run fn inside one transaction with tenant context set (RLS enforced). */
  withContext<T>(ctx: DbContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  /** Run fn inside one transaction with NO tenant context (pre-auth bootstrap only). */
  withSystem<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SET_CTX_SQL = `SELECT set_config('app.current_org_id', $1, true),
                            set_config('app.current_user_id', $2, true),
                            set_config('app.current_device_id', $3, true)`;

// ---------------------------------------------------------------------------
// node-postgres adapter (production)
// ---------------------------------------------------------------------------
class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  private async withTx<T>(ctx: DbContext | null, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (ctx) {
        await client.query(SET_CTX_SQL, [ctx.orgId, ctx.userId ?? null, ctx.deviceId ?? null]);
      }
      const tx: DbExecutor = {
        query: async (text, params) => {
          const r = await client.query(text, params ?? []);
          return { rows: r.rows as Row[], rowCount: r.rowCount ?? null };
        },
        exec: async (sql) => {
          await client.query(sql);
        },
      };
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  withContext<T>(ctx: DbContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.withTx(ctx, fn);
  }
  withSystem<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.withTx(null, fn);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// PGlite adapter (embedded PostgreSQL: sandbox preview, tests, CI)
// ---------------------------------------------------------------------------
export class PGliteDb implements Db {
  constructor(private readonly db: PGlite) {}

  private withTx<T>(ctx: DbContext | null, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      if (ctx) {
        await tx.query(SET_CTX_SQL, [ctx.orgId, ctx.userId ?? null, ctx.deviceId ?? null]);
      }
      const exec: DbExecutor = {
        query: async (text, params) => {
          const r = await tx.query(text, params ?? []);
          return { rows: r.rows as Row[], rowCount: (r as any).affectedRows ?? null };
        },
        exec: async (sql) => {
          await tx.exec(sql);
        },
      };
      return fn(exec);
    });
  }

  withContext<T>(ctx: DbContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.withTx(ctx, fn);
  }
  withSystem<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.withTx(null, fn);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

function pgExecutor(pool: Pool): SqlExecutor {
  return {
    exec: (sql) => pool.query(sql),
    query: async (text, params) => {
      const r = await pool.query(text, params ?? []);
      return { rows: r.rows as Row[] };
    },
  };
}

function pgliteExecutor(db: PGlite): SqlExecutor {
  return {
    exec: (sql) => db.exec(sql),
    query: async (text, params) => {
      const r = await db.query(text, params ?? []);
      return { rows: r.rows as Row[] };
    },
  };
}

export interface CreateDbOptions {
  /** Use this existing PGlite instance (tests). */
  pglite?: PGlite;
  /** Skip running migrations (tests run them explicitly). */
  skipMigrations?: boolean;
}

/**
 * Build the application Db.
 * - DATABASE_URL set  -> real PostgreSQL via node-postgres (migrated if AUTO_MIGRATE).
 * - otherwise         -> embedded in-memory PostgreSQL (PGlite), auto-migrated.
 */
export async function createDb(opts: CreateDbOptions = {}): Promise<Db> {
  const autoMigrate = (process.env.AUTO_MIGRATE ?? "true") !== "false";
  const databaseUrl = process.env.DATABASE_URL;

  if (opts.pglite) {
    if (!opts.skipMigrations) await runMigrations(pgliteExecutor(opts.pglite));
    return new PGliteDb(opts.pglite);
  }

  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    if (autoMigrate) await runMigrations(pgExecutor(pool));
    return new PgDb(pool);
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const instance = new PGlite();
  await runMigrations(pgliteExecutor(instance));
  return new PGliteDb(instance);
}

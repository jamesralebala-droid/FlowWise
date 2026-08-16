import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "node:crypto";
import { lastValueFrom, of, type Observable } from "rxjs";
import type { Response } from "express";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

/**
 * Invariant 4 — idempotent writes. Any POST that carries an Idempotency-Key
 * header is stored after the first successful execution; a retry (e.g. after
 * a dropped connection) is answered with the stored response and NEVER
 * executes the business logic again.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();

    if (req.method !== "POST" || !req.claims) return next.handle();
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
    if (!key) return next.handle();

    const ctx = { orgId: req.claims.org, userId: req.claims.sub, deviceId: req.claims.dev };
    const path = (req.originalUrl ?? req.url) as string;
    const requestHash = createHash("sha256").update(JSON.stringify({ path, body: req.body ?? {} })).digest("hex");

    const prior = await this.db.withContext(ctx, (tx) =>
      tx.query("SELECT status_code, response_body FROM http_idempotency WHERE org_id = $1 AND key = $2", [
        req.claims.org,
        key,
      ]),
    );
    if (prior.rows.length > 0) {
      res.status(Number(prior.rows[0].status_code));
      return of(prior.rows[0].response_body ?? {});
    }

    const result = await lastValueFrom(next.handle());
    const statusCode = (result as { statusCode?: number } | undefined)?.statusCode ?? 201;

    try {
      await this.db.withContext(ctx, (tx) =>
        tx.query(
          `INSERT INTO http_idempotency (org_id, key, method, path, request_hash, status_code, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [req.claims.org, key, req.method, path, requestHash, statusCode, JSON.stringify(result ?? {})],
        ),
      );
    } catch {
      // Concurrent duplicate: the unique (org_id, key) index makes the first writer win.
    }

    return of(result);
  }
}

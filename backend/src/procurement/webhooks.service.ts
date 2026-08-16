import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { AuditService } from "../auth/audit.service.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { requireString } from "../inventory/validate.js";

export interface CreateWebhookInput {
  url: string;
  /** event names, e.g. ["po.sent", "po.received"]; "po.*" matches all PO events */
  events?: string[];
  secret?: string;
}

const MAX_ATTEMPTS = 5;

export function poEventPayload(orgId: string, po: Record<string, any>): Record<string, unknown> {
  return {
    event: "", // filled in by enqueue()
    occurredAt: new Date().toISOString(),
    data: {
      orgId,
      poId: po.id,
      documentNo: po.documentNo,
      branchId: po.branchId,
      supplierId: po.supplierId,
      status: po.status,
      expectedDelivery: po.expectedDelivery ?? null,
    },
  };
}

function sign(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp};v1=${digest}`;
}

/**
 * Phase 3 — outbound webhooks for PO events. Every delivery is persisted
 * (pending → success/failed) so nothing is lost, signed with HMAC-SHA256 over
 * `t.<body>` (header `x-flowwise-signature: t=<ts>;v1=<hex>`, plus
 * `x-flowwise-event`), delivered in-process, and retried with exponential
 * backoff up to MAX_ATTEMPTS. A failed URL never blocks the request that
 * emitted the event: rows are enqueued inside the business transaction and
 * delivered after it commits.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Persists a pending delivery row per matching active webhook (inside the caller's tx). */
  async enqueue(tx: DbExecutor, orgId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const hooks = await tx.query(
      `SELECT id, secret FROM webhooks
       WHERE org_id = $1 AND is_active
         AND (events @> jsonb_build_array($2::text) OR events @> '["po.*"]'::jsonb)`,
      [orgId, event],
    );
    if (hooks.rows.length === 0) return;

    const body = JSON.stringify({ ...payload, event });
    for (const hook of hooks.rows) {
      const signature = sign(hook.secret as string, Math.floor(Date.now() / 1000), body);
      await tx.query(
        `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload, signature)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [orgId, hook.id, event, body, signature],
      );
    }
  }

  /** Fires due pending deliveries for an org (called AFTER the emitting tx commits). */
  async deliverDue(orgId: string): Promise<void> {
    let pending: { rows: Record<string, any>[] };
    try {
      pending = await this.db.withContext({ orgId }, async (tx) =>
        tx.query(
          `SELECT d.id, d.event, d.payload, d.signature, d.attempts, w.url, w.secret
           FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
           WHERE d.org_id = $1 AND d.status = 'pending' AND d.next_attempt_at <= now() AND d.attempts < $2
           ORDER BY d.created_at LIMIT 50`,
          [orgId, MAX_ATTEMPTS],
        ),
      );
    } catch {
      return; // nothing pending (or RLS hid it) — safe no-op
    }
    for (const row of pending.rows) {
      await this.deliverOne(orgId, row);
    }
  }

  async create(claims: JwtPayloadClaims, input: CreateWebhookInput): Promise<unknown> {
    const url = requireString(input.url, "url");
    if (!/^https?:\/\//.test(url)) throw new BadRequestException("url must be http(s)");
    const events = input.events && input.events.length > 0 ? input.events.map((e) => requireString(e, "events[]")) : ["po.*"];
    const secret = input.secret && input.secret.trim() ? input.secret.trim() : randomBytes(24).toString("hex");

    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `INSERT INTO webhooks (org_id, url, secret, events, created_by_user_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           RETURNING id, url, events, is_active AS "isActive", created_at AS "createdAt"`,
          [claims.org, url, secret, JSON.stringify(events), claims.sub],
        );
        const row = r.rows[0] as Record<string, unknown>;
        await this.audit.write(tx, "webhook.create", "webhook", row.id as string, null, JSON.stringify({ url, events }));
        // The secret is only shown once at creation.
        return { ...row, secret };
      },
    );
  }

  async list(claims: JwtPayloadClaims): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, url, events, is_active AS "isActive", created_at AS "createdAt"
           FROM webhooks WHERE org_id = $1 ORDER BY created_at LIMIT 100`,
          [claims.org],
        );
        return { webhooks: r.rows };
      },
    );
  }

  async deactivate(claims: JwtPayloadClaims, webhookId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `UPDATE webhooks SET is_active = false WHERE id = $1 AND org_id = $2
           RETURNING id, url, is_active AS "isActive"`,
          [webhookId, claims.org],
        );
        if (r.rows.length === 0) throw new NotFoundException("Webhook not found");
        await this.audit.write(tx, "webhook.deactivate", "webhook", webhookId, null, null);
        return r.rows[0];
      },
    );
  }

  /** Sends a `test` ping and returns the delivery result. */
  async test(claims: JwtPayloadClaims, webhookId: string): Promise<unknown> {
    const result = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const hook = await tx.query("SELECT id, secret FROM webhooks WHERE id = $1 AND org_id = $2 AND is_active", [webhookId, claims.org]);
        if (hook.rows.length === 0) throw new NotFoundException("Webhook not found");
        const payload = { event: "test", occurredAt: new Date().toISOString(), data: { webhookId } };
        const body = JSON.stringify(payload);
        const signature = sign(hook.rows[0].secret as string, Math.floor(Date.now() / 1000), body);
        const inserted = await tx.query(
          `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload, signature)
           VALUES ($1, $2, 'test', $3::jsonb, $4)
           RETURNING id, event, status, attempts`,
          [claims.org, webhookId, body, signature],
        );
        return inserted.rows[0] as { id: string; event: string; status: string; attempts: number };
      },
    );
    await this.deliverDue(claims.org);
    return this.delivery(claims.org, result.id);
  }

  /** Manual retry of a failed/pending delivery. */
  async retry(claims: JwtPayloadClaims, deliveryId: string): Promise<unknown> {
    const updated = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const r = await tx.query(
          `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now()
           WHERE id = $1 AND org_id = $2 AND status = 'failed'
           RETURNING id`,
          [deliveryId, claims.org],
        );
        if (r.rows.length === 0) throw new NotFoundException("Failed delivery not found");
        return r.rows[0] as { id: string };
      },
    );
    await this.deliverDue(claims.org);
    return this.delivery(claims.org, updated.id);
  }

  async deliveries(claims: JwtPayloadClaims, webhookId: string, limit = 50): Promise<unknown> {
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const safe = Math.min(Math.max(limit, 1), 200);
        const r = await tx.query(
          `SELECT id, event, payload, status, attempts, last_http_status AS "lastHttpStatus",
                  last_error AS "lastError", next_attempt_at AS "nextAttemptAt",
                  delivered_at AS "deliveredAt", created_at AS "createdAt"
           FROM webhook_deliveries
           WHERE org_id = $1 AND webhook_id = $2
           ORDER BY created_at DESC LIMIT $3`,
          [claims.org, webhookId, safe],
        );
        return { deliveries: r.rows };
      },
    );
  }

  // ---- internals ------------------------------------------------------------

  private async delivery(orgId: string, deliveryId: string): Promise<unknown> {
    return this.db.withContext(
      { orgId },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, event, payload, status, attempts, last_http_status AS "lastHttpStatus",
                  last_error AS "lastError", next_attempt_at AS "nextAttemptAt",
                  delivered_at AS "deliveredAt", created_at AS "createdAt"
           FROM webhook_deliveries WHERE id = $1 AND org_id = $2`,
          [deliveryId, orgId],
        );
        return r.rows[0] ?? null;
      },
    );
  }

  private async deliverOne(orgId: string, row: Record<string, any>): Promise<void> {
    const url = row.url as string;
    const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
    const attempts = (row.attempts as number) ?? 0;
    // The signature is computed over the EXACT bytes being sent, with a fresh
    // timestamp at delivery time — receivers verify by recomputing over the
    // received body, so nothing depends on a stored body round-tripping.
    const signature = sign(row.secret as string, Math.floor(Date.now() / 1000), body);
    let ok = false;
    let httpStatus: number | null = null;
    let error: string | null = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flowwise-event": String(row.event),
          "x-flowwise-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      httpStatus = res.status;
      ok = res.ok;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : "delivery failed";
    }

    const nextAttempts = attempts + 1;
    try {
      await this.db.withContext({ orgId }, async (tx) => {
        if (ok) {
          await tx.query(
            `UPDATE webhook_deliveries
             SET status = 'success', attempts = $2, last_http_status = $3, last_error = NULL,
                 signature = $5, delivered_at = now(), next_attempt_at = NULL
             WHERE id = $1 AND org_id = $4`,
            [row.id, nextAttempts, httpStatus, orgId, signature],
          );
        } else if (nextAttempts >= MAX_ATTEMPTS) {
          await tx.query(
            `UPDATE webhook_deliveries
             SET status = 'failed', attempts = $2, last_http_status = $3, last_error = $4,
                 next_attempt_at = NULL
             WHERE id = $1 AND org_id = $5`,
            [row.id, nextAttempts, httpStatus, error, orgId],
          );
        } else {
          await tx.query(
            `UPDATE webhook_deliveries
             SET attempts = $2, last_http_status = $3, last_error = $4,
                 next_attempt_at = now() + make_interval(secs => $5)
             WHERE id = $1 AND org_id = $6 AND status = 'pending'`,
            [row.id, nextAttempts, httpStatus, error, nextAttempts * 30, orgId],
          );
        }
      });
    } catch {
      /* delivery bookkeeping failure is non-fatal for the request */
    }
  }
}

import { BadRequestException, Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { Permissions } from "../auth/permissions.guard.js";

/**
 * Read-only view of the append-only audit trail (Phase 4 hardening: the
 * `audit.read` permission finally has a consumer). Rows are written by
 * fn_write_audit inside every privileged/business transaction; actors/org
 * come from session GUCs, never from the client.
 */
@Controller("audit")
export class AuditController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @Permissions("audit.read")
  async list(
    @Req() req: AuthedRequest,
    @Query() q: { action?: string; entityType?: string; since?: string; limit?: string },
  ) {
    const claims = req.claims;
    const clauses = ["org_id = $1"];
    const params: unknown[] = [claims.org];
    if (q.action) {
      params.push(q.action);
      clauses.push(`action = $${params.length}`);
    }
    if (q.entityType) {
      params.push(q.entityType);
      clauses.push(`entity_type = $${params.length}`);
    }
    if (q.since) {
      if (Number.isNaN(Date.parse(q.since))) {
        throw new BadRequestException("since must be an ISO timestamp");
      }
      params.push(q.since);
      clauses.push(`occurred_at > $${params.length}`);
    }
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 500);
    params.push(limit);

    const res = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) =>
        tx.query(
          `SELECT id, action, entity_type AS "entityType", entity_id AS "entityId",\n                  old_data AS "oldData", new_data AS "newData", ip, occurred_at AS \"occurredAt\"\n           FROM audit_log\n           WHERE ${clauses.join(" AND ")}\n           ORDER BY id DESC\n           LIMIT $${params.length}`,
          params,
        ),
    );
    return { events: res.rows };
  }
}

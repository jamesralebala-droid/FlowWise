import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AuditService } from "./audit.service.js";
import { sha256Hex } from "./oauth.service.js";
import { Permissions } from "./permissions.guard.js";
import type { AuthedRequest } from "./auth.guard.js";
import { DB_TOKEN } from "../db/constants.js";
import { Inject } from "@nestjs/common";
import type { Db } from "../db/db.js";

@Controller("devices")
export class DevicesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registers this device for the signed-in user. The device key is returned
   * exactly once — only its hash is stored. It is later presented as
   * X-Device-Key on sync uploads (Phase 1) and binds refresh tokens.
   */
  @Post("register")
  async register(
    @Req() req: AuthedRequest,
    @Body() body: { deviceName?: string; platform?: string; appVersion?: string },
  ): Promise<{ deviceId: string; deviceKey: string }> {
    const claims = req.claims;
    const deviceKey = randomBytes(32).toString("base64url");
    const deviceId = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO devices (org_id, user_id, device_name, platform, app_version, device_key_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [claims.org, claims.sub, body.deviceName?.trim() || "untitled", body.platform?.trim() || "android", body.appVersion ?? null, sha256Hex(deviceKey)],
        );
        await this.audit.write(
          tx,
          "device.register",
          "device",
          inserted.rows[0].id as string,
          null,
          JSON.stringify({ name: body.deviceName?.trim() || "untitled", platform: body.platform ?? "android" }),
        );
        return inserted.rows[0].id as string;
      },
    );
    return { deviceId, deviceKey };
  }

  /** Revokes a device: kills its refresh tokens and blocks its access JWTs. */
  @Post(":id/revoke")
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string): Promise<{ revoked: boolean }> {
    const claims = req.claims;
    await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const row = await tx.query(
          "SELECT user_id, is_active FROM devices WHERE id = $1 AND org_id = $2 FOR UPDATE",
          [id, claims.org],
        );
        if (row.rows.length === 0) throw new NotFoundException("Device not found");
        const isOwn = row.rows[0].user_id === claims.sub;
        const canManage = claims.perms.includes("devices.manage");
        if (!isOwn && !canManage) {
          throw new ForbiddenException("You may only revoke your own devices unless you can manage devices");
        }
        await tx.query("UPDATE devices SET is_active = false, revoked_at = now() WHERE id = $1 AND org_id = $2", [id, claims.org]);
        await tx.query("UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL", [id]);
        await this.audit.write(tx, "device.revoke", "device", id, JSON.stringify(row.rows[0]), JSON.stringify({ revokedAt: new Date().toISOString() }));
      },
    );
    return { revoked: true };
  }

  @Get()
  @Permissions("devices.manage")
  async list(@Req() req: AuthedRequest): Promise<{ devices: unknown[] }> {
    const claims = req.claims;
    const res = await this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      (tx) =>
        tx.query(
          `SELECT id, device_name, platform, app_version, is_active, bound_at, last_seen_at, revoked_at
           FROM devices WHERE org_id = $1 ORDER BY created_at DESC`,
          [claims.org],
        ),
    );
    return { devices: res.rows };
  }
}

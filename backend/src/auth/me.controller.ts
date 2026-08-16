import { Controller, Get, NotFoundException, Req } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import type { AuthedRequest } from "./auth.guard.js";

@Controller("me")
export class MeController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  async me(@Req() req: AuthedRequest) {
    const claims = req.claims;
    return this.db.withContext(
      { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
      async (tx) => {
        const user = await tx.query("SELECT id, email, name FROM users WHERE id = $1 AND org_id = $2", [claims.sub, claims.org]);
        if (user.rows.length === 0) throw new NotFoundException("User not found");

        const org = await tx.query(
          `SELECT id, name, slug, currency_code AS currency, timezone, vat_rate AS "vatRate"
           FROM organisations WHERE id = $1`,
          [claims.org],
        );

        const roles = await tx.query(
          `SELECT ura.branch_id AS "branchId", b.name AS "branchName", ura.role_code AS role
           FROM user_role_assignments ura
           LEFT JOIN branches b ON b.id = ura.branch_id
           WHERE ura.user_id = $1 AND ura.org_id = $2
           ORDER BY b.name NULLS LAST`,
          [claims.sub, claims.org],
        );

        const branches = await tx.query(
          "SELECT id, name, code, is_active FROM branches WHERE org_id = $1 AND is_active ORDER BY name",
          [claims.org],
        );

        const devices = await tx.query(
          "SELECT id, device_name, platform, app_version, is_active, bound_at FROM devices WHERE user_id = $1 AND org_id = $2",
          [claims.sub, claims.org],
        );

        const firstBranch = roles.rows.find((r) => r.branchId)?.branchId as string | undefined;
        return {
          id: user.rows[0].id,
          email: user.rows[0].email,
          name: user.rows[0].name,
          org: org.rows[0],
          roles: roles.rows,
          defaultBranch: firstBranch ?? null,
          branches: branches.rows,
          devices: devices.rows,
        };
      },
    );
  }
}

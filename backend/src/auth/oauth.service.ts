import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "../env.js";
import { DB_TOKEN } from "../db/constants.js";
import type { Db, DbExecutor } from "../db/db.js";
import { verifyPassword } from "../password.js";
import { JwtService, type RoleClaim } from "./jwt.service.js";

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
const b64urlSha256 = (s: string) => Buffer.from(createHash("sha256").update(s).digest()).toString("base64url");

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  is_active: boolean;
}

export interface CodeRow {
  id: string;
  org_id: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  code_challenge_method: string;
  expires_at: string;
  used_at: string | null;
}

export interface RefreshRow {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string | null;
  client_id: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

interface IssueInput {
  orgId: string;
  userId: string;
  clientId: string;
  deviceId: string | null;
  claims: { perms: string[]; roles: RoleClaim[] };
  /** rotations keep the original family so replay detection revokes the whole chain */
  familyId?: string;
}

@Injectable()
export class OauthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  // -- role/permission claims -------------------------------------------------
  private async roleAndPermClaims(tx: DbExecutor, userId: string, orgId: string): Promise<{ perms: string[]; roles: RoleClaim[] }> {
    const roles = await tx.query(
      `SELECT ura.branch_id AS "branchId", ura.role_code AS role, b.name AS "branchName"
       FROM user_role_assignments ura
       LEFT JOIN branches b ON b.id = ura.branch_id
       WHERE ura.user_id = $1 AND ura.org_id = $2`,
      [userId, orgId],
    );
    const perms = await tx.query(
      `SELECT DISTINCT p.code
       FROM role_permissions rp
       JOIN permissions p ON p.code = rp.permission_code
       JOIN user_role_assignments ura ON ura.role_code = rp.role_code
       WHERE ura.user_id = $1 AND ura.org_id = $2`,
      [userId, orgId],
    );
    return {
      roles: roles.rows.map((r) => ({ branchId: (r.branchId as string) ?? null, role: r.role as string })),
      perms: perms.rows.map((r) => r.code as string),
    };
  }

  // -- authorize ---------------------------------------------------------------
  async authorize(input: {
    username: string;
    password: string;
    clientId: string;
    redirectUri?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    /** sha256 hex of the client IP — throttle key (Phase 4 hardening). */
    ipHash?: string;
  }): Promise<{ code: string }> {
    const clients = await this.db.withSystem((tx) =>
      tx.query("SELECT id, client_id, is_active, redirect_uris FROM oauth_clients WHERE client_id = $1", [input.clientId]),
    );
    const client = clients.rows[0] as { id: string; is_active: boolean; redirect_uris: string[] } | undefined;
    if (!client || !client.is_active) throw new BadRequestException("Unknown or inactive client");

    if (input.redirectUri && Array.isArray(client.redirect_uris) && client.redirect_uris.length > 0) {
      if (!client.redirect_uris.includes(input.redirectUri)) {
        throw new BadRequestException("redirect_uri not allowed for this client");
      }
    }

    // ---- brute-force protection (Phase 4) ---------------------------------
    // Keyed by (normalized username, hashed IP) so a distributed attacker
    // still gets throttled per account, while one shared office IP does not
    // lock out everyone. Checked BEFORE the credential lookup so the throttle
    // reveals nothing about whether the account exists.
    const username = input.username.trim().toLowerCase();
    const ipHash = input.ipHash ?? "unknown";
    const recent = await this.db.withSystem((tx) =>
      tx.query(
        `SELECT count(*)::int AS n
         FROM auth_attempts
         WHERE username = $1 AND ip_hash = $2 AND success = false
           AND attempted_at > now() - make_interval(secs => $3)`,
        [username, ipHash, env.authAttemptWindowSeconds],
      ),
    );
    if ((recent.rows[0].n as number) >= env.authMaxFailedAttempts) {
      // 429 — this @nestjs/common build has no TooManyRequestsException class.
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: `Too many failed attempts for this account. Retry in ${env.authAttemptWindowSeconds}s` },
        HttpStatus.TOO_MANY_REQUESTS,
        { cause: "auth-throttled" },
      );
    }

    const recordFailure = () =>
      this.db.withSystem((tx) =>
        tx.query("INSERT INTO auth_attempts (username, ip_hash, success) VALUES ($1, $2, false)", [username, ipHash]),
      );

    const found = await this.db.withSystem((tx) => tx.query("SELECT * FROM auth_lookup_user_by_email($1)", [username]));
    const user = found.rows[0] as UserRow | undefined;
    if (!user || !user.is_active) {
      // Identical response for unknown user / inactive user / wrong password;
      // the failed attempt is recorded either way.
      await recordFailure();
      throw new UnauthorizedException("Invalid credentials");
    }
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      await recordFailure();
      throw new UnauthorizedException("Invalid credentials");
    }

    // A successful login clears the failure streak for this account+IP.
    await this.db.withSystem((tx) =>
      tx.query("DELETE FROM auth_attempts WHERE username = $1 AND ip_hash = $2 AND success = false", [username, ipHash]),
    );

    const code = randomToken();
    await this.db.withContext({ orgId: user.org_id, userId: user.id }, (tx) =>
      tx.query(
        `INSERT INTO authorization_codes
           (org_id, client_id, user_id, code_hash, redirect_uri, code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes')`,
        [user.org_id, input.clientId, user.id, sha256Hex(code), input.redirectUri ?? "", input.codeChallenge ?? null, input.codeChallengeMethod ?? "S256"],
      ),
    );
    return { code };
  }

  // -- token --------------------------------------------------------------------
  async token(input: {
    grantType: "authorization_code" | "refresh_token";
    code?: string;
    codeVerifier?: string;
    refreshToken?: string;
    clientId: string;
    redirectUri?: string;
    deviceId?: string | null;
  }): Promise<TokenResponse> {
    if (input.grantType === "authorization_code") return this.exchangeCode(input);
    return this.exchangeRefresh(input);
  }

  private async assertDeviceOwned(orgId: string, userId: string, deviceId: string): Promise<void> {
    const res = await this.db.withContext({ orgId, userId, deviceId }, (tx) =>
      tx.query("SELECT id FROM devices WHERE id = $1 AND org_id = $2 AND user_id = $3 AND revoked_at IS NULL", [deviceId, orgId, userId]),
    );
    if (res.rows.length === 0) throw new BadRequestException("Unknown or revoked device");
  }

  private async exchangeCode(input: {
    code?: string;
    codeVerifier?: string;
    clientId: string;
    redirectUri?: string;
    deviceId?: string | null;
  }): Promise<TokenResponse> {
    const code = input.code;
    const codeVerifier = input.codeVerifier;
    if (!code || !codeVerifier) throw new BadRequestException("code and code_verifier are required");
    const found = await this.db.withSystem((tx) => tx.query("SELECT * FROM oauth_lookup_code_by_hash($1)", [sha256Hex(code)]));
    const codeRow = found.rows[0] as CodeRow | undefined;
    if (!codeRow) throw new BadRequestException("Invalid authorization code");
    if (codeRow.used_at) throw new BadRequestException("Authorization code already used");
    if (new Date(codeRow.expires_at).getTime() < Date.now()) throw new BadRequestException("Authorization code expired");
    if (codeRow.client_id !== input.clientId) throw new BadRequestException("Client mismatch");

    const method = codeRow.code_challenge_method ?? "S256";
    const verifierOk =
      method === "plain"
        ? codeRow.code_challenge === codeVerifier
        : codeRow.code_challenge === b64urlSha256(codeVerifier);
    if (!verifierOk) throw new BadRequestException("PKCE verification failed");

    if (input.deviceId) {
      await this.assertDeviceOwned(codeRow.org_id, codeRow.user_id, input.deviceId);
    }

    return this.db.withContext({ orgId: codeRow.org_id, userId: codeRow.user_id, deviceId: input.deviceId ?? null }, async (tx) => {
      await tx.query("UPDATE authorization_codes SET used_at = now() WHERE id = $1", [codeRow.id]);
      const claims = await this.roleAndPermClaims(tx, codeRow.user_id, codeRow.org_id);
      const issued = await this.issueTokens(tx, {
        orgId: codeRow.org_id,
        userId: codeRow.user_id,
        clientId: input.clientId,
        deviceId: input.deviceId ?? null,
        claims,
      });
      return issued.tokens;
    });
  }

  private async exchangeRefresh(input: {
    refreshToken?: string;
    clientId: string;
    deviceId?: string | null;
  }): Promise<TokenResponse> {
    const refreshToken = input.refreshToken;
    if (!refreshToken) throw new BadRequestException("refresh_token is required");
    const found = await this.db.withSystem((tx) => tx.query("SELECT * FROM oauth_lookup_refresh_by_hash($1)", [sha256Hex(refreshToken)]));
    const rt = found.rows[0] as RefreshRow | undefined;
    if (!rt || new Date(rt.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (rt.client_id !== input.clientId) throw new BadRequestException("Client mismatch");
    if (input.deviceId) await this.assertDeviceOwned(rt.org_id, rt.user_id, input.deviceId);

    // Replay of a rotated (revoked) token revokes the whole family.
    if (rt.revoked_at) {
      await this.db.withContext({ orgId: rt.org_id, userId: rt.user_id, deviceId: rt.device_id ?? null }, (tx) =>
        tx.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND org_id = $2", [rt.family_id, rt.org_id]),
      );
      throw new UnauthorizedException("Refresh token reuse detected");
    }

    return this.db.withContext({ orgId: rt.org_id, userId: rt.user_id, deviceId: input.deviceId ?? rt.device_id ?? null }, async (tx) => {
      const claims = await this.roleAndPermClaims(tx, rt.user_id, rt.org_id);
      const issued = await this.issueTokens(tx, {
        orgId: rt.org_id,
        userId: rt.user_id,
        clientId: rt.client_id,
        deviceId: input.deviceId ?? rt.device_id ?? null,
        claims,
        familyId: rt.family_id,
      });
      // Rotation: the used token is revoked and linked to its replacement.
      await tx.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $1 WHERE id = $2", [issued.refreshId, rt.id]);
      return issued.tokens;
    });
  }

  private async issueTokens(
    tx: DbExecutor,
    input: IssueInput,
  ): Promise<{ tokens: TokenResponse; refreshId: string }> {
    const { token, expiresIn } = await this.jwt.sign({
      sub: input.userId,
      org: input.orgId,
      perms: input.claims.perms,
      roles: input.claims.roles,
      dev: input.deviceId,
    });
    const refresh = randomToken();
    const familyId = input.familyId ?? randomUUID();
    const inserted = await tx.query(
      `INSERT INTO refresh_tokens (org_id, user_id, device_id, client_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       RETURNING id`,
      [input.orgId, input.userId, input.deviceId, input.clientId, sha256Hex(refresh), familyId, env.refreshTokenTtlSeconds],
    );
    return {
      tokens: { access_token: token, token_type: "Bearer", expires_in: expiresIn, refresh_token: refresh },
      refreshId: inserted.rows[0].id as string,
    };
  }

  // -- revoke --------------------------------------------------------------------
  async revoke(token: string): Promise<void> {
    const found = await this.db.withSystem((tx) => tx.query("SELECT * FROM oauth_lookup_refresh_by_hash($1)", [sha256Hex(token)]));
    const rt = found.rows[0] as RefreshRow | undefined;
    if (!rt) return; // idempotent
    await this.db.withContext({ orgId: rt.org_id, userId: rt.user_id, deviceId: rt.device_id ?? null }, async (tx) => {
      await tx.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2", [rt.id, rt.org_id]);
      await tx.query("SELECT fn_write_audit('oauth.revoke', 'refresh_token', $1::uuid, NULL, $2::jsonb)", [
        rt.id,
        JSON.stringify({ family: rt.family_id }),
      ]);
    });
  }
}

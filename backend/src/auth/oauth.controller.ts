import { BadRequestException, Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { OauthService, type TokenResponse } from "./oauth.service.js";
import { Public } from "./auth.guard.js";

/** Client IP for brute-force throttling — hashed, never stored raw. */
const ipHash = (ip: string | undefined) => createHash("sha256").update(ip ?? "unknown").digest("hex");

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("oauth")
export class OauthController {
  constructor(private readonly oauth: OauthService) {}

  /**
   * Step 1 of the Authorization Code + PKCE flow. This is a native, public
   * client: the app submits the resource-owner credentials directly and, on
   * success, receives a short-lived, single-use authorization code bound to
   * its PKCE challenge.
   */
  @Public()
  @Post("authorize")
  async authorize(@Req() req: Request, @Body() body: Record<string, unknown>): Promise<{ code: string }> {
    return this.oauth.authorize({
      username: requireString(body.username, "username"),
      password: requireString(body.password, "password"),
      clientId: requireString(body.clientId, "clientId"),
      redirectUri: typeof body.redirectUri === "string" ? body.redirectUri : undefined,
      codeChallenge: typeof body.codeChallenge === "string" ? body.codeChallenge : undefined,
      codeChallengeMethod:
        typeof body.codeChallengeMethod === "string" ? body.codeChallengeMethod : "S256",
      ipHash: ipHash(req.ip),
    });
  }

  /** Step 2: exchange the code (with PKCE verifier) or rotate a refresh token. */
  @Public()
  @Post("token")
  @HttpCode(200)
  async token(@Body() body: Record<string, unknown>): Promise<TokenResponse> {
    const grantType = requireString(body.grantType, "grantType");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      throw new BadRequestException("Unsupported grant_type");
    }
    return this.oauth.token({
      grantType,
      code: typeof body.code === "string" ? body.code : undefined,
      codeVerifier: typeof body.codeVerifier === "string" ? body.codeVerifier : undefined,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
      clientId: requireString(body.clientId, "clientId"),
      redirectUri: typeof body.redirectUri === "string" ? body.redirectUri : undefined,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : null,
    });
  }

  /** Revoke a refresh token (idempotent). */
  @Public()
  @Post("revoke")
  @HttpCode(200)
  async revoke(@Body() body: Record<string, unknown>): Promise<{ revoked: boolean }> {
    await this.oauth.revoke(requireString(body.token, "token"));
    return { revoked: true };
  }
}

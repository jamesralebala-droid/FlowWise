import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { DB_TOKEN } from "../db/constants.js";
import type { Db } from "../db/db.js";
import { JwtService, type JwtPayloadClaims } from "./jwt.service.js";

export const PUBLIC_KEY = "flowwise:public";
/** Marks a route as reachable without a bearer token (oauth + health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export interface AuthedRequest extends Request {
  claims: JwtPayloadClaims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (isPublic) return true;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    let claims: JwtPayloadClaims;
    try {
      claims = await this.jwt.verify(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    // Close the revocation gap: access tokens live 15 min, but a revoked
    // device must stop working immediately.
    if (claims.dev) {
      const res = await this.db.withContext(
        { orgId: claims.org, userId: claims.sub, deviceId: claims.dev },
        (tx) => tx.query("SELECT revoked_at FROM devices WHERE id = $1 AND org_id = $2", [claims.dev, claims.org]),
      );
      if (res.rows.length === 0 || res.rows[0].revoked_at) {
        throw new UnauthorizedException("Device revoked");
      }
    }

    req.claims = claims;
    return true;
  }
}

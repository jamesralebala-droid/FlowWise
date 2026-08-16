import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthedRequest } from "./auth.guard.js";

export const PERMISSIONS_KEY = "flowwise:permissions";
export const Permissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.claims) throw new UnauthorizedException("Not authenticated");
    const missing = required.filter((p) => !req.claims.perms.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permission(s): ${missing.join(", ")}`);
    }
    return true;
  }
}

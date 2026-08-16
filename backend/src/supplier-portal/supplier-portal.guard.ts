import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.guard.js";

/**
 * Phase 7: supplier self-service portal. Tokens are issued by
 * POST /v1/supplier-portal/login with kind='supplier' and supplierId set;
 * their perms claim is exactly ['supplier.portal']. The regular AuthGuard
 * already validated the signature; this guard narrows the principal.
 */
@Injectable()
export class SupplierPortalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.claims) throw new UnauthorizedException("Not authenticated");
    if (req.claims.kind !== "supplier" || !req.claims.supplierId) {
      throw new ForbiddenException("Supplier portal credentials required");
    }
    if (!req.claims.perms.includes("supplier.portal")) {
      throw new ForbiddenException("Supplier portal access required");
    }
    return true;
  }
}

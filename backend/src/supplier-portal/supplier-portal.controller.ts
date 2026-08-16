import { createHash } from "node:crypto";
import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SupplierPortalService } from "./supplier-portal.service.js";
import { SupplierPortalGuard } from "./supplier-portal.guard.js";
import { Public } from "../auth/auth.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

/** The supplier id lives in the token, never in route params. */
function supplierId(req: AuthedRequest): string {
  return req.claims.supplierId as string;
}

@Controller("supplier-portal")
export class SupplierPortalController {
  constructor(private readonly portal: SupplierPortalService) {}

  @Public()
  @Post("login")
  async login(@Req() req: Request, @Body() body: { email?: string; password?: string }) {
    const email = body.email ?? "";
    const password = body.password ?? "";
    const ip = req.ip ?? "";
    const ipHash = createHash("sha256").update(email.toLowerCase() + ip).digest("hex");
    return this.portal.login({ email, password, ipHash });
  }

  @UseGuards(SupplierPortalGuard)
  @Get("me")
  async me(@Req() req: AuthedRequest) {
    return this.portal.me(req.claims.org, supplierId(req));
  }

  @UseGuards(SupplierPortalGuard)
  @Put("me")
  async updateProfile(
    @Req() req: AuthedRequest,
    @Body() body: { name?: string; contactPhone?: string; email?: string },
  ) {
    return this.portal.updateProfile(supplierId(req), req.claims.org, body);
  }

  @UseGuards(SupplierPortalGuard)
  @Get("purchase-orders")
  async purchaseOrders(@Req() req: AuthedRequest, @Query("status") status?: string) {
    return this.portal.purchaseOrders(req.claims.org, supplierId(req), { status });
  }

  @UseGuards(SupplierPortalGuard)
  @Get("purchase-orders/:id")
  async purchaseOrder(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.portal.purchaseOrder(req.claims.org, supplierId(req), id);
  }

  @UseGuards(SupplierPortalGuard)
  @Get("price-list")
  async priceList(@Req() req: AuthedRequest) {
    return this.portal.priceList(req.claims.org, supplierId(req));
  }

  @UseGuards(SupplierPortalGuard)
  @Put("price-list/:variantId")
  async updatePrice(@Req() req: AuthedRequest, @Param("variantId") variantId: string, @Body() body: { unitCost?: string }) {
    return this.portal.updatePrice(supplierId(req), req.claims.org, variantId, body);
  }
}

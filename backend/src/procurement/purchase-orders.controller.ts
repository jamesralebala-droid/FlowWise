import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { PurchaseOrdersService, type CreatePoInput } from "./purchase-orders.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("purchase-orders")
export class PurchaseOrdersController {
  constructor(private readonly pos: PurchaseOrdersService) {}

  /** Creates a draft PO from an open suggestion or explicit lines (replay-safe). */
  @Post()
  @Permissions("purchase.po")
  async create(@Req() req: AuthedRequest, @Body() body: CreatePoInput) {
    return this.pos.create(req.claims, body);
  }

  /** Sends the draft to the supplier — the approval step (owner / branch manager). */
  @Post(":id/send")
  @Permissions("purchase.po.approve")
  async send(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.pos.send(req.claims, requireString(id, "poId"));
  }

  @Post(":id/cancel")
  @Permissions("purchase.po")
  async cancel(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.pos.cancel(req.claims, requireString(id, "poId"));
  }

  @Get(":id")
  @Permissions("purchase.po")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.pos.get(req.claims, requireString(id, "poId"));
  }

  @Get()
  @Permissions("purchase.po")
  async list(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("status") status?: string) {
    return this.pos.list(req.claims, branchId, status);
  }
}

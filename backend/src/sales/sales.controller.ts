import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { SalesService, type CreateSaleInput, type RefundSaleInput } from "./sales.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("sales")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /**
   * Completes a sale: prices and totals are computed server-side, and the
   * document + ledger entries commit in one transaction (Invariant 3).
   * Replaying the same clientOperationId returns the original sale.
   */
  @Post()
  @Permissions("pos.sell")
  async create(@Req() req: AuthedRequest, @Body() body: CreateSaleInput) {
    return this.sales.create(req.claims, body);
  }

  /** Refund: a new document + reverse ledger movements; the sale is never edited. */
  @Post(":id/refund")
  @Permissions("pos.refund")
  async refund(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: RefundSaleInput) {
    return this.sales.refund(req.claims, {
      ...body,
      saleId: requireString(id, "saleId"),
    });
  }

  /** Pull: completed sales after a cursor (branch optional) — outbox sync. */
  @Get()
  @Permissions("sales.read")
  async list(
    @Req() req: AuthedRequest,
    @Query("branchId") branchId?: string,
    @Query("since") since?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.sales.list(req.claims, {
      branchId,
      since,
      limit: Number.isNaN(parsedLimit ?? NaN) ? undefined : parsedLimit,
    });
  }

  @Get(":id")
  @Permissions("sales.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.sales.get(req.claims, requireString(id, "saleId"));
  }
}

import { BadRequestException, Controller, Get, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { StockService } from "./stock.service.js";

@Controller("stock")
export class StockController {
  constructor(private readonly stock: StockService) {}

  /** Per-branch balances (derived cache — always reproducible from the ledger). */
  @Get("balances")
  @Permissions("stock.read")
  async balances(@Req() req: AuthedRequest, @Query("branchId") branchId?: string) {
    return this.stock.balances(req.claims, branchId);
  }

  /** Per-branch batch balances (FEFO ordering). */
  @Get("batches")
  @Permissions("stock.read")
  async batches(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("variantId") variantId?: string) {
    if (!branchId) throw new BadRequestException("branchId is required");
    return this.stock.batches(req.claims, branchId, variantId);
  }

  /** Low-stock alerts for configured reorder levels. */
  @Get("low-stock")
  @Permissions("stock.read")
  async lowStock(@Req() req: AuthedRequest, @Query("branchId") branchId?: string) {
    return this.stock.lowStock(req.claims, branchId);
  }

  /** Append-only ledger feed. */
  @Get("ledger")
  @Permissions("stock.read")
  async ledger(
    @Req() req: AuthedRequest,
    @Query("branchId") branchId?: string,
    @Query("since") since?: string,
    @Query("limit") limit?: string,
  ) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.stock.ledger(req.claims, branchId, since, Number.isNaN(parsed ?? NaN) ? undefined : parsed);
  }
}

import { Controller, Get, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { ReportsService, type ReportFilters } from "./reports.service.js";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Period totals + tender breakdown; refunds netted out. */
  @Get("sales-summary")
  @Permissions("reports.read")
  async salesSummary(@Req() req: AuthedRequest, @Query() q: ReportFilters) {
    return this.reports.salesSummary(req.claims, q);
  }

  /** Per-day buckets in the organisation's configured timezone. */
  @Get("daily-sales")
  @Permissions("reports.read")
  async dailySales(@Req() req: AuthedRequest, @Query() q: ReportFilters) {
    return this.reports.dailySales(req.claims, q);
  }

  /** Phase 5: on-hand stock valued at latest landed cost, per branch. */
  @Get("stock-valuation")
  @Permissions("reports.read")
  async stockValuation(@Req() req: AuthedRequest, @Query() q: ReportFilters) {
    return this.reports.stockValuation(req.claims, q);
  }

  /** Phase 5: revenue vs COGS per variant over a period. */
  @Get("margin")
  @Permissions("reports.read")
  async margin(@Req() req: AuthedRequest, @Query() q: ReportFilters) {
    return this.reports.margin(req.claims, q);
  }

  /** Phase 5: top products by revenue over a period. */
  @Get("top-products")
  @Permissions("reports.read")
  async topProducts(@Req() req: AuthedRequest, @Query() q: ReportFilters & { limit?: number }) {
    return this.reports.topProducts(req.claims, q);
  }
}

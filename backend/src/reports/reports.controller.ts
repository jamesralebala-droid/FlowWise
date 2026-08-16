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
}

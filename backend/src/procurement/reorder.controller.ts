import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { ReorderService, type EvaluateInput, type ReorderRuleInput } from "./reorder.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("reorder")
export class ReorderController {
  constructor(private readonly reorder: ReorderService) {}

  /** Create or update the reorder rule for (branch, variant). */
  @Post("rules")
  @Permissions("purchase.reorder")
  async upsertRule(@Req() req: AuthedRequest, @Body() body: ReorderRuleInput) {
    return this.reorder.upsertRule(req.claims, body);
  }

  @Get("rules")
  @Permissions("purchase.reorder")
  async listRules(@Req() req: AuthedRequest, @Query("branchId") branchId?: string) {
    return this.reorder.listRules(req.claims, branchId);
  }

  /**
   * Runs the suggestion evaluator for a branch. Explainable: every suggestion
   * carries the inputs and a readable reason. Re-running refreshes open
   * suggestions; dismissed/converted ones are preserved.
   */
  @Post("evaluate")
  @Permissions("purchase.reorder")
  async evaluate(@Req() req: AuthedRequest, @Body() body: EvaluateInput) {
    return this.reorder.evaluate(req.claims, body);
  }

  @Get("suggestions")
  @Permissions("purchase.reorder")
  async listSuggestions(
    @Req() req: AuthedRequest,
    @Query("branchId") branchId?: string,
    @Query("status") status?: string,
  ) {
    return this.reorder.listSuggestions(req.claims, branchId, status);
  }

  @Post("suggestions/:id/dismiss")
  @Permissions("purchase.reorder")
  async dismiss(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.reorder.dismissSuggestion(req.claims, requireString(id, "suggestionId"));
  }

  /** Trailing-window average daily demand per variant (the forecast). */
  @Get("forecast")
  @Permissions("purchase.reorder")
  async forecast(
    @Req() req: AuthedRequest,
    @Query("branchId") branchId: string,
    @Query("days") days?: string,
  ) {
    return this.reorder.forecast(req.claims, requireString(branchId, "branchId"), days ? Number(days) : 30);
  }
}

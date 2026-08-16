import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { AdjustmentsService, type CreateAdjustmentInput } from "./adjustments.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("adjustments")
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  /** Records a draft adjustment (stock.adjust). */
  @Post()
  @Permissions("stock.adjust")
  async create(@Req() req: AuthedRequest, @Body() body: CreateAdjustmentInput) {
    return this.adjustments.create(req.claims, body);
  }

  /** Approves + posts: signed ledger movements in ONE transaction (stock.adjust.approve). */
  @Post(":id/post")
  @Permissions("stock.adjust.approve")
  async post(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.adjustments.post(req.claims, requireString(id, "adjustmentId"));
  }

  @Get(":id")
  @Permissions("stock.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.adjustments.get(req.claims, requireString(id, "adjustmentId"));
  }

  @Get()
  @Permissions("stock.read")
  async list(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("status") status?: string) {
    return this.adjustments.list(req.claims, branchId, status);
  }
}

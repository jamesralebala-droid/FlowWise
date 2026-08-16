import { Body, Controller, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PromotionsService, type PromotionInput } from "./promotions.service.js";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

@Controller("promotions")
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @Permissions("promotion.manage")
  async list(@Req() req: AuthedRequest, @Query("activeOnly") activeOnly?: string) {
    return this.promotions.list(req.claims, { activeOnly: activeOnly === "true" });
  }

  @Post()
  @Permissions("promotion.manage")
  async create(@Req() req: AuthedRequest, @Body() body: PromotionInput) {
    return this.promotions.create(req.claims, body);
  }

  @Put(":id")
  @Permissions("promotion.manage")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: PromotionInput) {
    return this.promotions.update(req.claims, id, body);
  }
}

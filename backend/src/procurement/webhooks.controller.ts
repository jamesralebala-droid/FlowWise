import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { WebhooksService, type CreateWebhookInput } from "./webhooks.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @Permissions("purchase.webhook")
  async create(@Req() req: AuthedRequest, @Body() body: CreateWebhookInput) {
    return this.webhooks.create(req.claims, body);
  }

  @Get()
  @Permissions("purchase.webhook")
  async list(@Req() req: AuthedRequest) {
    return this.webhooks.list(req.claims);
  }

  @Delete(":id")
  @Permissions("purchase.webhook")
  async deactivate(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.webhooks.deactivate(req.claims, requireString(id, "webhookId"));
  }

  @Post(":id/test")
  @Permissions("purchase.webhook")
  async test(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.webhooks.test(req.claims, requireString(id, "webhookId"));
  }

  @Get(":id/deliveries")
  @Permissions("purchase.webhook")
  async deliveries(@Req() req: AuthedRequest, @Param("id") id: string, @Query("limit") limit?: string) {
    return this.webhooks.deliveries(req.claims, requireString(id, "webhookId"), limit ? Number(limit) : 50);
  }

  @Post("deliveries/:id/retry")
  @Permissions("purchase.webhook")
  async retry(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.webhooks.retry(req.claims, requireString(id, "deliveryId"));
  }
}

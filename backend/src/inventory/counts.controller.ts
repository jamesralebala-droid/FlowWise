import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { CountsService, type CountRecordInput, type CreateCountInput } from "./counts.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("counts")
export class CountsController {
  constructor(private readonly counts: CountsService) {}

  /** Opens a blind count — the counter sees variants, never expected quantities. */
  @Post()
  @Permissions("stock.count")
  async create(@Req() req: AuthedRequest, @Body() body: CreateCountInput) {
    return this.counts.create(req.claims, body);
  }

  /** Records the blind count per line (stock.count). */
  @Post(":id/record")
  @Permissions("stock.count")
  async record(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: CountRecordInput) {
    return this.counts.record(req.claims, requireString(id, "countId"), body);
  }

  /**
   * Approves + posts the count: server-computed variance becomes the
   * count_adjustment ledger movement (stock.count.approve).
   */
  @Post(":id/post")
  @Permissions("stock.count.approve")
  async post(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.counts.post(req.claims, requireString(id, "countId"));
  }

  @Get(":id")
  @Permissions("stock.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.counts.get(req.claims, requireString(id, "countId"));
  }

  @Get()
  @Permissions("stock.read")
  async list(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("status") status?: string) {
    return this.counts.list(req.claims, branchId, status);
  }
}

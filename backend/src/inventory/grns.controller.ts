import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { GrnsService, type CreateGrnInput } from "./grns.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("grns")
export class GrnsController {
  constructor(private readonly grns: GrnsService) {}

  /** Creates a draft GRN (or returns the stored one on replay of clientOperationId). */
  @Post()
  @Permissions("stock.grn")
  async create(@Req() req: AuthedRequest, @Body() body: CreateGrnInput) {
    return this.grns.create(req.claims, body);
  }

  /** Posts the draft: batch metadata + ledger movements + status in ONE transaction. */
  @Post(":id/post")
  @Permissions("stock.grn")
  async post(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.grns.post(req.claims, requireString(id, "grnId"));
  }

  @Get(":id")
  @Permissions("stock.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.grns.get(req.claims, requireString(id, "grnId"));
  }

  @Get()
  @Permissions("stock.read")
  async list(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("status") status?: string) {
    return this.grns.list(req.claims, branchId, status);
  }
}

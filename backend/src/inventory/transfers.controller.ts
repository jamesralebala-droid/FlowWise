import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { TransfersService, type CreateTransferInput } from "./transfers.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("transfers")
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** Creates a draft transfer (replay-safe on clientOperationId). */
  @Post()
  @Permissions("stock.transfer")
  async create(@Req() req: AuthedRequest, @Body() body: CreateTransferInput) {
    return this.transfers.create(req.claims, body);
  }

  /** Posts the draft: both ledger legs commit in ONE transaction. */
  @Post(":id/post")
  @Permissions("stock.transfer")
  async post(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.transfers.post(req.claims, requireString(id, "transferId"));
  }

  @Get(":id")
  @Permissions("stock.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.transfers.get(req.claims, requireString(id, "transferId"));
  }

  @Get()
  @Permissions("stock.read")
  async list(@Req() req: AuthedRequest, @Query("branchId") branchId?: string, @Query("status") status?: string) {
    return this.transfers.list(req.claims, branchId, status);
  }
}

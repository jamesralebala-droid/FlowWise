import { Body, Controller, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { CustomersService, type CustomerInput, type SettleInput } from "./customers.service.js";

@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Permissions("customer.read")
  async list(@Req() req: AuthedRequest, @Query() q: { q?: string }) {
    return this.customers.list(req.claims, { q: q.q });
  }

  @Post()
  @Permissions("customer.write")
  async create(@Req() req: AuthedRequest, @Body() body: CustomerInput) {
    return this.customers.create(req.claims, body);
  }

  @Get(":id")
  @Permissions("customer.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.customers.get(req.claims, id);
  }

  @Put(":id")
  @Permissions("customer.write")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: CustomerInput) {
    return this.customers.update(req.claims, id, body);
  }

  @Get(":id/statement")
  @Permissions("customer.read")
  async statement(@Req() req: AuthedRequest, @Param("id") id: string, @Query() q: { from?: string; to?: string }) {
    return this.customers.statement(req.claims, id, { from: q.from, to: q.to });
  }

  @Post(":id/settlements")
  @Permissions("customer.settle")
  async settle(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: Omit<SettleInput, "customerId">) {
    return this.customers.settle(req.claims, { ...body, customerId: id });
  }
}

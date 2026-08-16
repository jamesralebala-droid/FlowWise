import { Body, Controller, Get, Param, Post, Put, Req } from "@nestjs/common";
import { CurrenciesService, type CurrencyInput } from "./currencies.service.js";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

@Controller("currencies")
export class CurrenciesController {
  constructor(private readonly currencies: CurrenciesService) {}

  @Get()
  @Permissions("catalogue.read")
  async list(@Req() req: AuthedRequest) {
    return this.currencies.list(req.claims);
  }

  @Post()
  @Permissions("settings.manage")
  async create(@Req() req: AuthedRequest, @Body() body: CurrencyInput) {
    return this.currencies.create(req.claims, body);
  }

  @Put(":code")
  @Permissions("settings.manage")
  async update(@Req() req: AuthedRequest, @Param("code") code: string, @Body() body: CurrencyInput) {
    return this.currencies.update(req.claims, code, body);
  }
}

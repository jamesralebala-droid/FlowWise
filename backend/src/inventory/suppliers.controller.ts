import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { SuppliersService, type CreateSupplierInput, type SupplierProductMapping } from "./suppliers.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Post()
  @Permissions("stock.grn")
  async create(@Req() req: AuthedRequest, @Body() body: CreateSupplierInput) {
    return this.suppliers.create(req.claims, body);
  }

  @Put(":id")
  @Permissions("stock.grn")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: Partial<CreateSupplierInput>) {
    return this.suppliers.update(req.claims, requireString(id, "supplierId"), body);
  }

  /** Replace-all variant mappings for this supplier (cost basis hints for GRNs). */
  @Put(":id/products")
  @Permissions("stock.grn")
  async setProducts(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { products: SupplierProductMapping[] }) {
    return this.suppliers.setProducts(req.claims, requireString(id, "supplierId"), body.products ?? []);
  }

  @Get(":id")
  @Permissions("stock.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.suppliers.get(req.claims, requireString(id, "supplierId"));
  }

  @Get()
  @Permissions("stock.read")
  async list(@Req() req: AuthedRequest) {
    return this.suppliers.list(req.claims);
  }
}

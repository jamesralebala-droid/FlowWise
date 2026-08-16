import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { ShiftsService, type OpenShiftInput, type CloseShiftInput } from "./shifts.service.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /** Opens a till shift at a branch with the opening float. */
  @Post()
  @Permissions("shift.open")
  async open(@Req() req: AuthedRequest, @Body() body: OpenShiftInput) {
    return this.shifts.open(req.claims, body);
  }

  /** Cash-up: closes the shift, comparing declared tenders to expectations. */
  @Post(":id/close")
  @Permissions("shift.close")
  async close(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: CloseShiftInput) {
    return this.shifts.close(req.claims, { ...body, shiftId: requireString(id, "shiftId") });
  }

  @Get(":id")
  @Permissions("sales.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.shifts.get(req.claims, requireString(id, "shiftId"));
  }

  @Get()
  @Permissions("sales.read")
  async list(
    @Req() req: AuthedRequest,
    @Query("branchId") branchId?: string,
    @Query("status") status?: string,
  ) {
    return this.shifts.list(req.claims, branchId, status);
  }
}

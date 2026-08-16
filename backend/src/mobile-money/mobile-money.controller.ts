import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { MobileMoneyService, type MobileMoneyWebhookBody } from "./mobile-money.service.js";
import { Public } from "../auth/auth.guard.js";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

@Controller("mobile-money")
export class MobileMoneyController {
  constructor(private readonly mobileMoney: MobileMoneyService) {}

  /** Till/back-office pull of payment statuses. */
  @Get("payments")
  @Permissions("payment.read")
  async list(
    @Req() req: AuthedRequest,
    @Query() q: { branchId?: string; status?: string; since?: string; limit?: string },
  ) {
    return this.mobileMoney.list(req.claims, {
      branchId: q.branchId,
      status: q.status,
      since: q.since,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  /**
   * Provider callback. HMAC-verified against DODO_WEBHOOK_SECRET over the raw
   * body (signature header `x-dodo-signature`). Without a configured secret
   * every call is rejected — a gateway callback is never trusted by default.
   */
  @Public()
  @Post("webhook")
  async webhook(@Req() req: Request, @Body() body: MobileMoneyWebhookBody) {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
    const signature = typeof req.headers["x-dodo-signature"] === "string" ? req.headers["x-dodo-signature"] : undefined;
    return this.mobileMoney.handleWebhook(raw, signature, body);
  }
}

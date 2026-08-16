import { Body, Controller, Post, Req } from "@nestjs/common";
import { Permissions } from "../auth/permissions.guard.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { ReceiptsService, type ReceiptEmailInput } from "./receipts.service.js";

@Controller("receipts")
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /** Emails a receipt for a completed sale (found by its client op id). */
  @Post("email")
  @Permissions("pos.sell")
  async email(@Req() req: AuthedRequest, @Body() body: ReceiptEmailInput) {
    return this.receipts.sendReceipt(req.claims, body);
  }
}

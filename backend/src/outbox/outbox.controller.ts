import { Body, Controller, Post, Req } from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { OutboxService, type OutboxPushInput } from "./outbox.service.js";

@Controller("outbox")
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Flushes the device's offline queue. No route-level permission: per-operation
   * permissions are enforced inside the service (a cashier's refund op fails
   * with 403 while the rest of the batch proceeds), and different roles flush
   * different op types.
   */
  @Post()
  async push(@Req() req: AuthedRequest, @Body() body: OutboxPushInput) {
    return this.outbox.push(req.claims, body);
  }
}

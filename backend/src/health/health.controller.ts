import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/auth.guard.js";

@Controller("healthz")
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: "ok", service: "flowwise-api" };
  }
}

import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuditService } from "./auth/audit.service.js";
import { DevicesController } from "./auth/devices.controller.js";
import { JwtService } from "./auth/jwt.service.js";
import { MeController } from "./auth/me.controller.js";
import { OauthController } from "./auth/oauth.controller.js";
import { OauthService } from "./auth/oauth.service.js";
import { PermissionsGuard } from "./auth/permissions.guard.js";
import { CatalogueController } from "./catalogue/catalogue.controller.js";
import { DB_TOKEN } from "./db/constants.js";
import { createDb } from "./db/db.js";
import { env } from "./env.js";
import { HealthController } from "./health/health.controller.js";
import { IdempotencyInterceptor } from "./idempotency/idempotency.interceptor.js";
import { OutboxController } from "./outbox/outbox.controller.js";
import { OutboxService } from "./outbox/outbox.service.js";
import { ReportsController } from "./reports/reports.controller.js";
import { ReportsService } from "./reports/reports.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { AdjustmentsController } from "./inventory/adjustments.controller.js";
import { AdjustmentsService } from "./inventory/adjustments.service.js";
import { CountsController } from "./inventory/counts.controller.js";
import { CountsService } from "./inventory/counts.service.js";
import { GrnsController } from "./inventory/grns.controller.js";
import { GrnsService } from "./inventory/grns.service.js";
import { StockController } from "./inventory/stock.controller.js";
import { StockService } from "./inventory/stock.service.js";
import { SuppliersController } from "./inventory/suppliers.controller.js";
import { SuppliersService } from "./inventory/suppliers.service.js";
import { TransfersController } from "./inventory/transfers.controller.js";
import { TransfersService } from "./inventory/transfers.service.js";
import { PurchaseOrdersController } from "./procurement/purchase-orders.controller.js";
import { PurchaseOrdersService } from "./procurement/purchase-orders.service.js";
import { ReorderController } from "./procurement/reorder.controller.js";
import { ReorderService } from "./procurement/reorder.service.js";
import { ScorecardController } from "./procurement/scorecard.controller.js";
import { WebhooksController } from "./procurement/webhooks.controller.js";
import { WebhooksService } from "./procurement/webhooks.service.js";
import { SalesController } from "./sales/sales.controller.js";
import { SalesService } from "./sales/sales.service.js";
import { ShiftsController } from "./shifts/shifts.controller.js";
import { ShiftsService } from "./shifts/shifts.service.js";

@Module({
  controllers: [
    OauthController,
    DevicesController,
    MeController,
    CatalogueController,
    SalesController,
    ShiftsController,
    OutboxController,
    ReportsController,
    GrnsController,
    TransfersController,
    CountsController,
    AdjustmentsController,
    StockController,
    ScorecardController, // must precede SuppliersController so /suppliers/scorecard wins over /suppliers/:id
    SuppliersController,
    ReorderController,
    PurchaseOrdersController,
    WebhooksController,
    AuditController,
    HealthController,
  ],
  providers: [
    { provide: DB_TOKEN, useFactory: () => createDb() },
    {
      provide: JwtService,
      useFactory: () =>
        new JwtService(
          new TextEncoder().encode(env.jwtSecret),
          env.issuer,
          env.audience,
          env.accessTokenTtlSeconds,
        ),
    },
    OauthService,
    AuditService,
    SalesService,
    ShiftsService,
    OutboxService,
    ReportsService,
    SuppliersService,
    GrnsService,
    TransfersService,
    CountsService,
    AdjustmentsService,
    StockService,
    ReorderService,
    PurchaseOrdersService,
    WebhooksService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}

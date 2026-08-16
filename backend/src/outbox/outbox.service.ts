import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import type { Db } from "../db/db.js";
import { DB_TOKEN } from "../db/constants.js";
import type { JwtPayloadClaims } from "../auth/jwt.service.js";
import { SalesService, type CreateSaleInput, type RefundSaleInput } from "../sales/sales.service.js";
import { GrnsService, type CreateGrnInput } from "../inventory/grns.service.js";
import { TransfersService, type CreateTransferInput } from "../inventory/transfers.service.js";
import { AdjustmentsService, type CreateAdjustmentInput } from "../inventory/adjustments.service.js";
import { CountsService } from "../inventory/counts.service.js";
import { CustomersService, type SettleInput } from "../customers/customers.service.js";
import { ReceiptsService, type ReceiptEmailInput } from "../receipts/receipts.service.js";

export interface OutboxOperation {
  /** client-generated id echoed back so the device can match results */
  id: string;
  type: "sale" | "refund" | "grn" | "transfer" | "adjustment" | "count.post" | "customer.settle" | "receipt.email";
  clientOperationId: string;
  payload: Record<string, unknown>;
}

export interface OutboxPushInput {
  operations: OutboxOperation[];
}

export interface OutboxOpResult {
  id: string;
  status: "ok" | "error";
  httpStatus?: number;
  body?: unknown;
  error?: string;
}

/**
 * Push half of the offline outbox: the till flushes its queued operations in
 * one call. Each operation is dispatched through the normal write path, so
 * Invariant 4 holds per operation (clientOperationId dedupe inside the sale/
 * refund services — a retried op resolves to the same business effect).
 * Operations are isolated: one bad op never blocks the rest of the batch.
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly sales: SalesService,
    private readonly grns: GrnsService,
    private readonly transfers: TransfersService,
    private readonly adjustments: AdjustmentsService,
    private readonly counts: CountsService,
    private readonly customers: CustomersService,
    private readonly receipts: ReceiptsService,
  ) {}

  async push(claims: JwtPayloadClaims, input: OutboxPushInput): Promise<{ results: OutboxOpResult[] }> {
    const ops = input.operations ?? [];
    if (ops.length === 0) throw new BadRequestException("operations must not be empty");
    if (ops.length > 500) throw new BadRequestException("too many operations in one batch (max 500)");

    const results: OutboxOpResult[] = [];
    for (const op of ops) {
      if (typeof op.id !== "string" || !op.id) {
        results.push({ id: String(op.id), status: "error", httpStatus: 400, error: "operation id is required" });
        continue;
      }
      const clientOperationId = typeof op.clientOperationId === "string" ? op.clientOperationId.trim() : "";
      if (!clientOperationId) {
        results.push({ id: op.id, status: "error", httpStatus: 400, error: "clientOperationId is required" });
        continue;
      }

      try {
        if (op.type === "sale") {
          if (!claims.perms.includes("pos.sell")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission pos.sell" });
            continue;
          }
          const body = await this.sales.create(claims, {
            ...(op.payload as unknown as CreateSaleInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "refund") {
          if (!claims.perms.includes("pos.refund")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission pos.refund" });
            continue;
          }
          const body = await this.sales.refund(claims, {
            ...(op.payload as unknown as RefundSaleInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "grn") {
          // The payload may include poId — a stock controller can receive a
          // purchase order offline; the ledger rows + PO received-quantity
          // update still land atomically on reconnect (Invariant 3).
          if (!claims.perms.includes("stock.grn")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission stock.grn" });
            continue;
          }
          const body = await this.grns.createAndPost(claims, {
            ...(op.payload as unknown as CreateGrnInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "transfer") {
          if (!claims.perms.includes("stock.transfer")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission stock.transfer" });
            continue;
          }
          const body = await this.transfers.createAndPost(claims, {
            ...(op.payload as unknown as CreateTransferInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "adjustment") {
          // createAndPost = record + approve in one op; only approvers may do
          // this offline (draft-only recording stays online).
          if (!claims.perms.includes("stock.adjust.approve")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission stock.adjust.approve" });
            continue;
          }
          const body = await this.adjustments.createAndPost(claims, {
            ...(op.payload as unknown as CreateAdjustmentInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "count.post") {
          if (!claims.perms.includes("stock.count.approve")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission stock.count.approve" });
            continue;
          }
          const countId = typeof op.payload?.countId === "string" ? op.payload.countId : "";
          if (!countId) {
            results.push({ id: op.id, status: "error", httpStatus: 400, error: "payload.countId is required" });
            continue;
          }
          const body = await this.counts.post(claims, countId);
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "customer.settle") {
          // Offline payment against a customer account (Phase 5).
          if (!claims.perms.includes("customer.settle")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission customer.settle" });
            continue;
          }
          const body = await this.customers.settle(claims, {
            ...(op.payload as unknown as SettleInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else if (op.type === "receipt.email") {
          // eReceipt: found by the SALE's client op id (same batch, queued
          // after the sale in createdAt order). Replay-safe per recipient.
          if (!claims.perms.includes("pos.sell")) {
            results.push({ id: op.id, status: "error", httpStatus: 403, error: "missing permission pos.sell" });
            continue;
          }
          const body = await this.receipts.sendReceipt(claims, {
            ...(op.payload as unknown as ReceiptEmailInput),
            clientOperationId,
          });
          results.push({ id: op.id, status: "ok", httpStatus: 201, body });
        } else {
          results.push({ id: op.id, status: "error", httpStatus: 400, error: `unsupported operation type: ${String(op.type)}` });
        }
      } catch (err) {
        if (err instanceof HttpException) {
          results.push({ id: op.id, status: "error", httpStatus: err.getStatus(), error: err.message });
        } else {
          results.push({ id: op.id, status: "error", httpStatus: 500, error: "internal error" });
        }
      }
    }
    return { results };
  }
}

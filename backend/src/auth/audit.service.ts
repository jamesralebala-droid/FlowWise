import { Injectable } from "@nestjs/common";
import type { DbExecutor } from "../db/db.js";

@Injectable()
export class AuditService {
  /**
   * Writes an audit row inside the caller's transaction. Actor/org/device come
   * from the session GUCs, never from client input (see fn_write_audit).
   */
  async write(
    tx: DbExecutor,
    action: string,
    entityType: string,
    entityId: string | null,
    oldData?: string | null,
    newData?: string | null,
  ): Promise<void> {
    await tx.query("SELECT fn_write_audit($1, $2, $3::uuid, $4::jsonb, $5::jsonb)", [
      action,
      entityType,
      entityId,
      oldData ?? null,
      newData ?? null,
    ]);
  }
}

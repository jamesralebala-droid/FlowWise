package com.botwise.flowwise.data.outbox

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.botwise.flowwise.FlowWiseApp
import com.botwise.flowwise.data.remote.ApiException
import org.json.JSONArray
import org.json.JSONObject

/**
 * Flushes the offline outbox to POST /v1/outbox (Phase 1).
 *
 * Every operation carries its client_operation_id; the backend dedupes on
 * (org, client_operation_id) inside the sale/refund write paths, so a retried
 * upload after a dropped connection resolves to the same business effect
 * (Invariant 4). Results are matched back by the operation id and each op is
 * acknowledged individually:
 *   - ok            -> mark "synced"
 *   - error 4xx     -> mark "failed" (permanent; never retried)
 *   - error 5xx     -> stays "pending", retried on the next flush
 *   - batch-level 4xx -> every op is failed (payload the server rejects)
 *   - batch-level 401 -> rotate the access token (AuthManager.refresh) and
 *                        retry — ops are NEVER failed on auth trouble
 *   - network / 5xx -> Result.retry() (WorkManager backoff)
 */
class OutboxWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as FlowWiseApp).container
        var token = container.authManager.accessToken
        if (token == null) {
            // No access token: the 15-minute session may simply have lapsed —
            // rotate before declaring the flush impossible. Pending ops are
            // NEVER failed on auth trouble (Invariant: no silent drops).
            if (container.authManager.refresh()) token = container.authManager.accessToken
            if (token == null) return Result.retry()
        }
        val pending = container.outboxDao.pending()
        if (pending.isEmpty()) return Result.success()

        val operations = JSONArray()
        for (op in pending) {
            operations.put(
                JSONObject()
                    .put("id", op.id.toString())
                    .put("type", op.opType)
                    .put("clientOperationId", op.clientOperationId)
                    .put("payload", JSONObject(op.payloadJson)),
            )
        }

        return try {
            val response = container.apiClient.post(
                "/outbox",
                JSONObject().put("operations", operations),
                token,
            )
            val results = response.getJSONArray("results")
            val now = System.currentTimeMillis()
            val byId = pending.associateBy { it.id.toString() }
            for (i in 0 until results.length()) {
                val result = results.getJSONObject(i)
                val op = byId[result.getString("id")] ?: continue
                when (result.getString("status")) {
                    "ok" -> container.outboxDao.markSynced(op.id, "synced", now)
                    "error" -> {
                        val http = result.optInt("httpStatus", 500)
                        // 401 is never permanent here (a stale access token is
                        // the batch's problem, not this op's) — leave pending.
                        if (http in 400..499 && http != 401) {
                            container.outboxDao.markSynced(op.id, "failed", now)
                        }
                        // 5xx stays pending: retried on the next flush
                    }
                }
                container.outboxDao.bumpAttempts(op.id)
            }
            Result.success()
        } catch (e: ApiException) {
            if (e.code == 401) {
                // Stale access token: rotate and let the next flush retry with
                // fresh credentials. The ops stay pending — never failed.
                container.authManager.refresh()
                Result.retry()
            } else if (e.code in 400..499) {
                // The server rejected the batch itself: failing these ops is
                // cheaper than retrying a payload it will never accept.
                val now = System.currentTimeMillis()
                for (op in pending) container.outboxDao.markSynced(op.id, "failed", now)
                Result.success()
            } else {
                Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        }
    }
}

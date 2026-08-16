package com.botwise.flowwise.data.outbox

import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.remote.ApiClient
import com.botwise.flowwise.data.remote.ApiException
import org.json.JSONArray
import org.json.JSONObject

/** Outcome of one flush attempt. */
enum class FlushOutcome {
    /** Nothing pending, or everything acknowledgable was acknowledged. */
    SUCCESS,

    /** Try again later: network trouble, 5xx, or an auth rotation was needed. */
    RETRY,
}

/**
 * Shared flush logic for POST /v1/outbox, used by the WorkManager
 * [OutboxWorker] (automatic, network-constrained) and the in-app Sync queue
 * screen (manual "Sync now") so both paths behave identically.
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
 *   - network / 5xx -> RETRY (WorkManager backoff / next manual flush)
 */
object OutboxFlusher {

    suspend fun flush(api: ApiClient, auth: AuthManager, outboxDao: OutboxDao): FlushOutcome {
        var token = auth.accessToken
        if (token == null) {
            // No access token: the 15-minute session may simply have lapsed —
            // rotate before declaring the flush impossible. Pending ops are
            // NEVER failed on auth trouble (Invariant: no silent drops).
            if (auth.refresh()) token = auth.accessToken
            if (token == null) return FlushOutcome.RETRY
        }
        val pending = outboxDao.pending()
        if (pending.isEmpty()) return FlushOutcome.SUCCESS

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
            val response = api.post("/outbox", JSONObject().put("operations", operations), token)
            val results = response.getJSONArray("results")
            val now = System.currentTimeMillis()
            val byId = pending.associateBy { it.id.toString() }
            for (i in 0 until results.length()) {
                val result = results.getJSONObject(i)
                val op = byId[result.getString("id")] ?: continue
                when (result.getString("status")) {
                    "ok" -> outboxDao.markSynced(op.id, "synced", now)
                    "error" -> {
                        val http = result.optInt("httpStatus", 500)
                        // 401 is never permanent here (a stale access token is
                        // the batch's problem, not this op's) — leave pending.
                        if (http in 400..499 && http != 401) {
                            outboxDao.markSynced(op.id, "failed", now)
                        }
                        // 5xx stays pending: retried on the next flush
                    }
                }
                outboxDao.bumpAttempts(op.id)
            }
            FlushOutcome.SUCCESS
        } catch (e: ApiException) {
            when {
                e.code == 401 -> {
                    // Stale access token: rotate and let the next flush retry
                    // with fresh credentials. The ops stay pending — never failed.
                    auth.refresh()
                    FlushOutcome.RETRY
                }
                e.code in 400..499 -> {
                    // The server rejected the batch itself: failing these ops is
                    // cheaper than retrying a payload it will never accept.
                    val now = System.currentTimeMillis()
                    for (op in pending) outboxDao.markSynced(op.id, "failed", now)
                    FlushOutcome.SUCCESS
                }
                else -> FlushOutcome.RETRY
            }
        } catch (e: Exception) {
            FlushOutcome.RETRY
        }
    }
}

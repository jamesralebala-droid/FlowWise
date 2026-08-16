package com.botwise.flowwise.data.outbox

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.remote.ApiClient

/**
 * UI state for the Sync queue screen: the recent outbox_operations (pending /
 * synced / failed) plus a manual "Sync now" that runs the exact same flush
 * path as the automatic OutboxWorker (shared [OutboxFlusher]).
 */
class OutboxState(
    private val api: ApiClient,
    private val auth: AuthManager,
    private val outboxDao: OutboxDao,
) {
    var ops by mutableStateOf<List<OutboxOperationEntity>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    val pendingCount: Int get() = ops.count { it.status == "pending" }
    val syncedCount: Int get() = ops.count { it.status == "synced" }
    val failedCount: Int get() = ops.count { it.status == "failed" }

    suspend fun load() {
        busy = true
        error = null
        try {
            ops = outboxDao.recent()
        } catch (e: Exception) {
            error = e.message ?: "Could not read the local queue"
        } finally {
            busy = false
        }
    }

    /** Manual flush — identical semantics to the background worker. */
    suspend fun flushNow() {
        busy = true
        error = null
        try {
            val outcome = OutboxFlusher.flush(api, auth, outboxDao)
            ops = outboxDao.recent()
            message = when (outcome) {
                FlushOutcome.SUCCESS ->
                    if (ops.none { it.status == "pending" }) {
                        "Queue is empty — everything has synced"
                    } else {
                        "Sync finished — see below for anything still pending"
                    }
                FlushOutcome.RETRY ->
                    "Could not reach the server — pending ops retry automatically"
            }
        } catch (e: Exception) {
            error = e.message ?: "Sync failed"
        } finally {
            busy = false
        }
    }

    fun dismissError() {
        error = null
    }

    fun dismissMessage() {
        message = null
    }
}

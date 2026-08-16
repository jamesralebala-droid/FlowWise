package com.botwise.flowwise.data.outbox

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.botwise.flowwise.FlowWiseApp

/**
 * Flushes the offline outbox to POST /v1/outbox (Phase 1), constrained to
 * connectivity by WorkManager. The flush logic itself lives in
 * [OutboxFlusher] so the in-app Sync queue ("Sync now") and this automatic
 * worker behave identically — same dedup, same per-op ack semantics, same
 * "never fail on auth trouble" rule.
 */
class OutboxWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as FlowWiseApp).container
        return when (
            OutboxFlusher.flush(container.apiClient, container.authManager, container.outboxDao)
        ) {
            FlushOutcome.SUCCESS -> Result.success()
            FlushOutcome.RETRY -> Result.retry()
        }
    }
}

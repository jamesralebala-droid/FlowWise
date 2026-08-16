package com.botwise.flowwise.data.refunds

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.remote.ApiClient
import java.math.BigDecimal
import java.util.UUID
import org.json.JSONObject

/** A completed sale shown in the refund picker (loaded online). */
data class RefundableSale(
    val id: String,
    val clientOperationId: String,
    val total: String,
    val businessTime: String,
    val tenders: List<String>,
    val hasMobileMoney: Boolean,
    val mobileMoneyConfirmed: Boolean,
)

fun saleFromJson(o: JSONObject): RefundableSale {
    val tendersJson = o.optJSONArray("tenders") ?: org.json.JSONArray()
    val tenders = (0 until tendersJson.length()).map { tendersJson.getJSONObject(it).optString("tenderType") }
    val payments = o.optJSONArray("payments") ?: org.json.JSONArray()
    val mobileConfirmed = (0 until payments.length()).any {
        payments.getJSONObject(it).optString("status") == "confirmed"
    }
    return RefundableSale(
        id = o.optString("id"),
        clientOperationId = o.optString("clientOperationId"),
        total = o.optString("total", "0"),
        businessTime = o.optString("businessTime"),
        tenders = tenders,
        hasMobileMoney = tenders.contains("mobile_money"),
        mobileMoneyConfirmed = mobileConfirmed,
    )
}

/**
 * Refunds (Phase 8): pick a completed sale, enter the amount + reason, and
 * queue the refund OFFLINE-FIRST like every other till write — the op flushes
 * through POST /v1/outbox as `refund`, replay-safe by client_operation_id.
 * A refund of a mobile-money sale triggers a payout to the customer's wallet
 * server-side (Phase 7) once the op lands.
 */
class RefundState(
    private val api: ApiClient,
    private val auth: AuthManager,
    private val outboxDao: OutboxDao,
) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var sales by mutableStateOf<List<RefundableSale>>(emptyList())
        private set
    /** The sale currently being refunded. */
    var selected by mutableStateOf<RefundableSale?>(null)
        private set
    var amount by mutableStateOf("")
        private set
    var reason by mutableStateOf("")
        private set
    var queuedOpId by mutableStateOf<String?>(null)
        private set

    private val token: String
        get() = auth.accessToken ?: throw IllegalStateException("Not logged in")

    /** Loads the latest completed sales for the picker (online read). */
    suspend fun load() {
        busy = true
        error = null
        try {
            val res = api.get("/sales?limit=25", token)
            val arr = res.optJSONArray("sales")
            sales = (0 until (arr?.length() ?: 0)).map { saleFromJson(arr!!.getJSONObject(it)) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load sales"
        } finally {
            busy = false
        }
    }

    fun select(sale: RefundableSale) {
        selected = sale
        amount = sale.total
        reason = ""
        queuedOpId = null
        error = null
        message = null
    }

    fun setAmount(v: String) {
        amount = v
    }

    fun setReason(v: String) {
        reason = v
    }

    /**
     * Queues the refund to the local outbox. Returns the client operation id
     * (shown to the cashier so they can track it in the Sync queue). Works
     * with zero network — the flush happens on reconnect.
     */
    fun queueRefund(): String? {
        val sale = selected ?: run {
            error = "Pick a sale first"
            return null
        }
        val parsed = amount.toBigDecimalOrNull()
        if (parsed == null || parsed <= BigDecimal.ZERO) {
            error = "Enter a positive refund amount"
            return null
        }
        if (parsed > sale.total.toBigDecimal()) {
            error = "Refund cannot exceed the sale total"
            return null
        }
        val clientOperationId = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("saleId", sale.id)
            .put("amount", parsed.toPlainString())
        if (reason.isNotBlank()) payload.put("reason", reason.trim())

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "refund",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        message = if (sale.hasMobileMoney) {
            "Refund queued — a mobile-money payout back to the customer's wallet is initiated when it syncs"
        } else {
            "Refund queued — it syncs when the network returns"
        }
        queuedOpId = clientOperationId
        return clientOperationId
    }

    fun clearSelection() {
        selected = null
        queuedOpId = null
    }

    fun dismissError() {
        error = null
    }

    fun dismissMessage() {
        message = null
    }
}

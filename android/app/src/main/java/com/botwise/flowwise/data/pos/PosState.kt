package com.botwise.flowwise.data.pos

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.remote.ApiClient
import com.botwise.flowwise.data.shift.ShiftInfo
import com.botwise.flowwise.data.shift.ShiftStore
import com.botwise.flowwise.ui.scan.ResolvedItem
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * One cart line. Money/quantity are BigDecimal only — never floats — and the
 * payload sent to the backend stays a decimal string (Invariant: no floats
 * anywhere, ever).
 */
data class CartItem(
    val variantId: String,
    val name: String,
    val unitPrice: String,
    val quantity: BigDecimal,
    val barcode: String,
) {
    val lineTotal: BigDecimal get() = BigDecimal(unitPrice).multiply(quantity)
}

/** Local confirmation of a completed sale; syncs to the server via the outbox. */
data class ReceiptData(
    val clientOperationId: String,
    val lines: List<String>,
    val total: String,
    val tenders: List<String>,
    val changeDue: String,
    val timestamp: Long,
)

/** One tender line on a sale: server tenderType + decimal-string amount. */
data class TenderEntry(
    val type: String,
    val amount: String,
)

private val TENDER_LABELS = mapOf(
    "cash" to "Cash",
    "card" to "Card",
    "mobileMoney" to "Mobile money",
    "credit" to "Credit",
    "other" to "Other",
)

/** Result of a cash-up, for display on the till. */
data class ShiftResult(
    val expectedTotal: String?,
    val variance: String?,
    val message: String,
)

fun formatMoney(value: BigDecimal): String =
    "P " + value.setScale(2, RoundingMode.HALF_UP).toPlainString()

/**
 * UI state for the till (cart, open shift, receipt) plus the POS actions.
 * Complete-sale is OFFLINE-FIRST: the document is written to
 * outbox_operations with a unique client_operation_id; the OutboxWorker
 * flushes it to POST /v1/outbox when the network returns, and the server
 * dedupes by client_operation_id so a retried upload has exactly one effect.
 */
class PosState(
    private val api: ApiClient,
    private val auth: AuthManager,
    private val outboxDao: OutboxDao,
    private val shiftStore: ShiftStore,
) {
    var items by mutableStateOf<List<CartItem>>(emptyList())
        private set
    var shift by mutableStateOf(shiftStore.current)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var receipt by mutableStateOf<ReceiptData?>(null)
        private set
    var shiftResult by mutableStateOf<ShiftResult?>(null)
        private set
    var pendingOps by mutableStateOf(0)
        private set

    val total: BigDecimal
        get() = items.fold(BigDecimal.ZERO) { acc, item -> acc.add(item.lineTotal) }

    /** Adds a scanned item, merging quantity if it is already in the cart. */
    fun addItem(item: ResolvedItem): Boolean {
        val price = item.price
        if (price == null) {
            error = "No price for ${item.name} — cannot sell"
            return false
        }
        val existing = items.firstOrNull { it.variantId == item.variantId }
        items = if (existing == null) {
            items + CartItem(item.variantId, item.name, price, BigDecimal.ONE, item.barcode)
        } else {
            items.map { line ->
                if (line.variantId == item.variantId) line.copy(quantity = line.quantity + BigDecimal.ONE) else line
            }
        }
        error = null
        return true
    }

    /** +/- on a cart line; a quantity of zero removes the line. */
    fun changeQuantity(variantId: String, delta: Int) {
        items = items.mapNotNull { line ->
            if (line.variantId != variantId) line
            else {
                val next = line.quantity.add(BigDecimal(delta))
                if (next <= BigDecimal.ZERO) null else line.copy(quantity = next)
            }
        }
    }

    fun clearError() {
        error = null
    }

    /** Refreshes the offline-op counter shown on the till and home screens. */
    suspend fun refreshPendingOps() {
        pendingOps = outboxDao.pendingCount()
    }

    /**
     * Completes the sale into the LOCAL outbox (works with zero network).
     * Tenders are (tenderType, decimal-string amount) pairs — cash, card,
     * mobile money etc. — and the change due is only what the tender sum
     * exceeds the total by. Tenders and totals stay decimal strings end to end.
     */
    suspend fun completeSale(tendersInput: List<TenderEntry>) {
        if (items.isEmpty()) {
            error = "Cart is empty"
            return
        }
        val tenders = tendersInput.mapNotNull { entry ->
            val amount = entry.amount.toBigDecimalOrNull()
            if (amount == null || amount <= BigDecimal.ZERO) null
            else TenderEntry(entry.type, amount.toPlainString())
        }
        if (tenders.isEmpty()) {
            error = "Enter at least one tender amount"
            return
        }
        val totalTendered = tenders.fold(BigDecimal.ZERO) { acc, t -> acc.add(BigDecimal(t.amount)) }
        if (totalTendered < total) {
            error = "Tendered is less than the total"
            return
        }
        val branchId = auth.selectedBranchId
        if (branchId == null) {
            error = "No branch selected"
            return
        }

        val clientOperationId = UUID.randomUUID().toString()
        val lines = JSONArray()
        for (item in items) {
            lines.put(
                JSONObject()
                    .put("variantId", item.variantId)
                    .put("quantity", item.quantity.toPlainString()),
            )
        }
        val tendersJson = JSONArray()
        for (t in tenders) {
            tendersJson.put(JSONObject().put("tenderType", t.type).put("amount", t.amount))
        }
        val payload = JSONObject()
            .put("branchId", branchId)
            .put("lines", lines)
            .put("tenders", tendersJson)
        shift?.let { payload.put("shiftId", it.id) }

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "sale",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )

        receipt = ReceiptData(
            clientOperationId = clientOperationId,
            lines = items.map { "${it.name} × ${it.quantity.toPlainString()}" },
            total = formatMoney(total),
            tenders = tenders.map { "${TENDER_LABELS[it.type] ?: it.type}  ${formatMoney(BigDecimal(it.amount))}" },
            changeDue = formatMoney(totalTendered.subtract(total)),
            timestamp = System.currentTimeMillis(),
        )
        items = emptyList()
        error = null
    }

    /** Opens a till shift on the selected branch with the opening float. */
    suspend fun openShift(openingCashInput: String) {
        val branchId = auth.selectedBranchId
        if (branchId == null) {
            error = "No branch selected"
            return
        }
        busy = true
        error = null
        try {
            val opening = openingCashInput.toBigDecimalOrNull() ?: BigDecimal.ZERO
            val token = auth.accessToken ?: throw IllegalStateException("Not logged in")
            val res = api.post(
                "/shifts",
                JSONObject()
                    .put("branchId", branchId)
                    .put("openingCash", opening.toPlainString()),
                token,
            )
            val info = ShiftInfo(res.getString("id"), branchId, System.currentTimeMillis())
            shiftStore.current = info
            shift = info
        } catch (e: Exception) {
            error = e.message ?: "Could not open shift"
        } finally {
            busy = false
        }
    }

    /**
     * Cash-up: sends the DECLARED tenders; expected totals and variance are
     * computed server-side. Idempotent by Idempotency-Key, so a retried
     * close never double-reconciles.
     */
    suspend fun closeShift(declared: Map<String, String>) {
        val info = shift
        if (info == null) {
            error = "No open shift"
            return
        }
        busy = true
        error = null
        try {
            val token = auth.accessToken ?: throw IllegalStateException("Not logged in")
            val body = JSONObject()
                .put("declaredCash", declared["cash"] ?: "0")
                .put("declaredCard", declared["card"] ?: "0")
                .put("declaredMobileMoney", declared["mobileMoney"] ?: "0")
                .put("declaredCredit", declared["credit"] ?: "0")
                .put("declaredOther", declared["other"] ?: "0")
            val res = api.post(
                "/shifts/${info.id}/close",
                body,
                token,
                idempotencyKey = "shift-close-${info.id}",
            )
            shiftStore.current = null
            shift = null
            shiftResult = ShiftResult(
                expectedTotal = res.optString("expectedTotal", "").ifBlank { null },
                variance = res.optString("variance", "").ifBlank { null },
                message = "Shift closed",
            )
        } catch (e: Exception) {
            error = e.message ?: "Could not close shift"
        } finally {
            busy = false
        }
    }

    /** Drops the remembered open shift (e.g. after switching branches). */
    fun clearShift() {
        shiftStore.current = null
        shift = null
    }

    fun dismissShiftResult() {
        shiftResult = null
    }

    fun dismissReceipt() {
        receipt = null
    }
}

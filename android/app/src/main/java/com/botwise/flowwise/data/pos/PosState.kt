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
    /** Customer account when the sale was on credit (Phase 5). */
    val customerName: String? = null,
    /** eReceipt recipient when the cashier asked for one at the till. */
    val emailTo: String? = null,
)

/** One tender line on a sale: server tenderType + decimal-string amount. */
data class TenderEntry(
    val type: String,
    val amount: String,
    /** Phase 6: mobile-money tenders carry the customer's phone number. */
    val reference: String? = null,
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
    /** Phase 5: customers loaded for credit-sale selection (list picker). */
    var customers by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    /** Phase 5: the account the credit portion of the current cart charges to. */
    var creditCustomerId by mutableStateOf<String?>(null)
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

    /** Loads the customer accounts for the credit-sale picker (online read). */
    suspend fun loadCustomers() {
        if (customers.isNotEmpty()) return
        try {
            val token = auth.accessToken ?: return
            val res = api.get("/customers", token)
            val arr = res.optJSONArray("customers")
            customers = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
        } catch (_: Exception) {
            // The till keeps selling cash/card; the picker just stays empty.
        }
    }

    fun selectCreditCustomer(id: String?) {
        creditCustomerId = id
    }

    /**
     * Phase 5: emails a receipt for an ALREADY-COMPLETED sale (found by its
     * client operation id). Online-first — used from the receipt screen to
     * send a receipt the cashier forgot to queue. Returns an error string,
     * or null on success.
     */
    suspend fun emailReceipt(clientOperationId: String, to: String): String? {
        val trimmed = to.trim()
        if (trimmed.isEmpty()) return "Enter an email address"
        busy = true
        error = null
        try {
            val token = auth.accessToken ?: throw IllegalStateException("Not logged in")
            api.post(
                "/receipts/email",
                JSONObject().put("clientOperationId", clientOperationId).put("to", trimmed),
                token,
            )
            return null
        } catch (e: Exception) {
            return e.message ?: "Could not email the receipt"
        } finally {
            busy = false
        }
    }

    /**
     * Completes the sale into the LOCAL outbox (works with zero network).
     * Tenders are (tenderType, decimal-string amount) pairs — cash, card,
     * mobile money etc. — and the change due is only what the tender sum
     * exceeds the total by. Tenders and totals stay decimal strings end to end.
     *
     * Phase 6: promotionCode (validated server-side, usage counted in the same
     * transaction) and loyaltyPoints (customer balance checked server-side,
     * append-only earn/redeem rows). The SERVER is authoritative for both.
     */
    suspend fun completeSale(
        tendersInput: List<TenderEntry>,
        customerId: String? = null,
        emailTo: String? = null,
        promotionCode: String? = null,
        loyaltyPoints: Int? = null,
    ) {
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
        val hasCredit = tenders.any { it.type == "credit" }
        val wantsLoyalty = (loyaltyPoints ?: 0) > 0
        if ((hasCredit || wantsLoyalty) && customerId.isNullOrBlank()) {
            error = "Select a customer account"
            return
        }
        if (wantsLoyalty && (loyaltyPoints ?: 0) > 1_000_000) {
            error = "Points amount is too large"
            return
        }
        val mobilePhone = tenders.firstOrNull { it.type == "mobileMoney" }?.reference?.trim()
        if (tenders.any { it.type == "mobileMoney" } && mobilePhone.isNullOrBlank()) {
            error = "Enter the customer's mobile number for the mobile-money payment"
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
        val receiptEmail = emailTo?.trim().orEmpty().ifEmpty { null }

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
            val tender = JSONObject().put("tenderType", t.type).put("amount", t.amount)
            if (t.reference?.isNotBlank() == true) tender.put("reference", t.reference)
            tendersJson.put(tender)
        }
        val payload = JSONObject()
            .put("branchId", branchId)
            .put("lines", lines)
            .put("tenders", tendersJson)
        if (customerId != null) payload.put("customerId", customerId)
        val code = promotionCode?.trim().orEmpty()
        if (code.isNotEmpty()) payload.put("promotionCode", code)
        val points = loyaltyPoints ?: 0
        if (points > 0) payload.put("loyaltyRedeem", JSONObject().put("points", points))
        shift?.let { payload.put("shiftId", it.id) }

        // Sale first, then (optional) eReceipt op — the outbox flushes in
        // createdAt order, so the email is dispatched AFTER the sale exists
        // server-side (receipt.email is found by the sale's client op id).
        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "sale",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        if (receiptEmail != null) {
            outboxDao.insert(
                OutboxOperationEntity(
                    clientOperationId = "email:" + clientOperationId,
                    opType = "receipt.email",
                    payloadJson = JSONObject()
                        .put("clientOperationId", clientOperationId)
                        .put("to", receiptEmail)
                        .toString(),
                    idempotencyKey = "email:" + clientOperationId,
                ),
            )
        }

        val customer = customers.firstOrNull { it.optString("id") == customerId }
        receipt = ReceiptData(
            clientOperationId = clientOperationId,
            lines = items.map { "${it.name} × ${it.quantity.toPlainString()}" },
            total = formatMoney(total),
            tenders = tenders.map { "${TENDER_LABELS[it.type] ?: it.type}  ${formatMoney(BigDecimal(it.amount))}" },
            changeDue = formatMoney(totalTendered.subtract(total)),
            timestamp = System.currentTimeMillis(),
            customerName = customer?.optString("name"),
            emailTo = receiptEmail,
        )
        items = emptyList()
        creditCustomerId = null
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

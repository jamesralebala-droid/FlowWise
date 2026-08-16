package com.botwise.flowwise.data.inventory

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.remote.ApiClient
import java.math.BigDecimal
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** A GRN line as drafted on the till (decimal strings end to end). */
data class GrnLineDraft(
    val variantId: String,
    val variantName: String,
    val quantity: String,
    val unitCost: String,
    val batchNo: String,
    val expiryDate: String,
)

data class TransferLineDraft(
    val variantId: String,
    val variantName: String,
    val quantity: String,
)

data class AdjustmentLineDraft(
    val variantId: String,
    val variantName: String,
    val quantity: String,
    val unitCost: String,
)

/**
 * Inventory operations (Phase 2 UI on top of the Phase 2 backend).
 *
 * Reads (balances, low-stock, suppliers) hit the API directly. Writes are
 * OFFLINE-FIRST for GRNs / transfers / adjustments: the document is queued to
 * outbox_operations with a unique client_operation_id, and the existing
 * OutboxWorker flushes it to POST /v1/outbox (op types grn / transfer /
 * adjustment — the server createAndPost path commits the document + ledger
 * rows atomically on reconnect, Invariant 3, deduped by client_operation_id,
 * Invariant 4).
 *
 * Stock counts stay ONLINE (create → record → post): a count needs the
 * server-side count id before its lines can be recorded, so the blind-count
 * workflow cannot be queued offline in full. The outbox still supports
 * count.post for the final step on flaky networks.
 */
class InventoryState(
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

    var balances by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var lowStock by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var suppliers by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var pendingOps by mutableStateOf(0)
        private set

    /** The open (uncounted / recorded) count being worked on this session. */
    var activeCount by mutableStateOf<JSONObject?>(null)
        private set
    var countVariants by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    private val token: String
        get() = auth.accessToken ?: throw IllegalStateException("Not logged in")

    suspend fun loadStock() {
        busy = true
        error = null
        try {
            val branchId = auth.selectedBranchId
            val b = api.get("/stock/balances?branchId=$branchId", token).optJSONArray("balances")
            val l = api.get("/stock/low-stock?branchId=$branchId", token).optJSONArray("lowStock")
            val s = api.get("/suppliers", token).optJSONArray("suppliers")
            balances = (0 until (b?.length() ?: 0)).map { b!!.getJSONObject(it) }
            lowStock = (0 until (l?.length() ?: 0)).map { l!!.getJSONObject(it) }
            suppliers = (0 until (s?.length() ?: 0)).map { s!!.getJSONObject(it) }
            pendingOps = outboxDao.pendingCount()
        } catch (e: Exception) {
            error = e.message ?: "Could not load stock"
        } finally {
            busy = false
        }
    }

    /**
     * Queues a GRN for the selected branch. supplierId optional; lines carry
     * variant + quantity + landed unit cost (+ batch/expiry when known).
     */
    suspend fun queueGrn(supplierId: String?, notes: String?, lines: List<GrnLineDraft>): Boolean {
        if (lines.isEmpty()) {
            error = "Add at least one line"
            return false
        }
        val branchId = auth.selectedBranchId ?: run {
            error = "No branch selected"
            return false
        }
        if (lines.any { it.quantity.toBigDecimalOrNull() == null || it.quantity.toBigDecimalOrNull()!! <= BigDecimal.ZERO }) {
            error = "Quantities must be positive numbers"
            return false
        }
        if (lines.any { it.unitCost.toBigDecimalOrNull() == null || it.unitCost.toBigDecimalOrNull()!! < BigDecimal.ZERO }) {
            error = "Unit costs must be zero or positive"
            return false
        }

        val clientOperationId = UUID.randomUUID().toString()
        val jsonLines = JSONArray()
        for (line in lines) {
            val l = JSONObject()
                .put("variantId", line.variantId)
                .put("quantity", line.quantity)
                .put("unitCost", line.unitCost)
            if (line.batchNo.isNotBlank()) l.put("batchNo", line.batchNo)
            if (line.expiryDate.isNotBlank()) l.put("expiryDate", line.expiryDate)
            jsonLines.put(l)
        }
        val payload = JSONObject()
            .put("branchId", branchId)
            .put("lines", jsonLines)
        supplierId?.let { payload.put("supplierId", it) }
        notes?.let { if (it.isNotBlank()) payload.put("notes", it) }

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "grn",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        pendingOps = outboxDao.pendingCount()
        message = "GRN queued — it syncs when the network returns"
        return true
    }

    /** Queues a branch-to-branch transfer (from = selected branch). */
    suspend fun queueTransfer(toBranchId: String, notes: String?, lines: List<TransferLineDraft>): Boolean {
        if (lines.isEmpty()) {
            error = "Add at least one line"
            return false
        }
        val fromBranchId = auth.selectedBranchId ?: run {
            error = "No branch selected"
            return false
        }
        if (toBranchId.isBlank() || toBranchId == fromBranchId) {
            error = "Choose a different destination branch"
            return false
        }
        if (lines.any { it.quantity.toBigDecimalOrNull() == null || it.quantity.toBigDecimalOrNull()!! <= BigDecimal.ZERO }) {
            error = "Quantities must be positive numbers"
            return false
        }

        val clientOperationId = UUID.randomUUID().toString()
        val jsonLines = JSONArray()
        for (line in lines) {
            jsonLines.put(JSONObject().put("variantId", line.variantId).put("quantity", line.quantity))
        }
        val payload = JSONObject()
            .put("fromBranchId", fromBranchId)
            .put("toBranchId", toBranchId)
            .put("lines", jsonLines)
        notes?.let { if (it.isNotBlank()) payload.put("notes", it) }

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "transfer",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        pendingOps = outboxDao.pendingCount()
        message = "Transfer queued — it syncs when the network returns"
        return true
    }

    /** Queues an increase/decrease adjustment with a mandatory reason. */
    suspend fun queueAdjustment(adjustmentType: String, reason: String, notes: String?, lines: List<AdjustmentLineDraft>): Boolean {
        if (lines.isEmpty()) {
            error = "Add at least one line"
            return false
        }
        val branchId = auth.selectedBranchId ?: run {
            error = "No branch selected"
            return false
        }
        if (reason.isBlank()) {
            error = "A reason is required for every adjustment"
            return false
        }
        if (lines.any { it.quantity.toBigDecimalOrNull() == null || it.quantity.toBigDecimalOrNull()!! <= BigDecimal.ZERO }) {
            error = "Quantities must be positive numbers"
            return false
        }

        val clientOperationId = UUID.randomUUID().toString()
        val jsonLines = JSONArray()
        for (line in lines) {
            val l = JSONObject().put("variantId", line.variantId).put("quantity", line.quantity)
            if (line.unitCost.isNotBlank()) l.put("unitCost", line.unitCost)
            jsonLines.put(l)
        }
        val payload = JSONObject()
            .put("branchId", branchId)
            .put("adjustmentType", adjustmentType)
            .put("reason", reason)
            .put("lines", jsonLines)
        notes?.let { if (it.isNotBlank()) payload.put("notes", it) }

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "adjustment",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        pendingOps = outboxDao.pendingCount()
        message = "Adjustment queued — it syncs when the network returns"
        return true
    }

    /** Opens a blind count: the counter only sees the variant list (id → label). */
    suspend fun openCount(selected: List<Pair<String, String>>, notes: String?): Boolean {
        if (selected.isEmpty()) {
            error = "Pick at least one variant to count"
            return false
        }
        val branchId = auth.selectedBranchId ?: run {
            error = "No branch selected"
            return false
        }
        busy = true
        error = null
        try {
            val ids = JSONArray()
            selected.forEach { (id, _) -> ids.put(id) }
            val body = JSONObject()
                .put("branchId", branchId)
                .put("variantIds", ids)
            notes?.let { if (it.isNotBlank()) body.put("notes", it) }
            val res = api.post("/counts", body, token)
            activeCount = res
            // Keep the count sheet in the same order the counter picked.
            countVariants = selected.map { (id, label) ->
                JSONObject().put("variantId", id).put("variantName", label).put("quantity", "")
            }
            message = "Count ${res.optString("documentNo", "").ifBlank { res.optString("id") }} open — record the quantities"
            return true
        } catch (e: Exception) {
            error = e.message ?: "Could not open count"
            return false
        } finally {
            busy = false
        }
    }

    /** Updates one counted-quantity field on the local count sheet. */
    fun updateCountQuantity(index: Int, value: String) {
        if (index in countVariants.indices) {
            countVariants = countVariants.mapIndexed { i, r -> if (i == index) r.put("quantity", value) else r }
        }
    }

    /** Records the blind quantities against the open count (server computes variance). */
    suspend fun recordCount(): Boolean {
        val count = activeCount ?: run {
            error = "No open count"
            return false
        }
        val counted = JSONArray()
        for (row in countVariants) {
            val qty = row.optString("quantity", "").trim()
            if (qty.isEmpty()) {
                error = "Record a quantity for every variant in the count"
                return false
            }
            if (qty.toBigDecimalOrNull() == null || qty.toBigDecimalOrNull()!! < BigDecimal.ZERO) {
                error = "Counted quantities must be zero or positive numbers"
                return false
            }
            counted.put(JSONObject().put("variantId", row.getString("variantId")).put("quantity", qty))
        }
        busy = true
        error = null
        try {
            val res = api.post("/counts/${count.getString("id")}/record", JSONObject().put("counted", counted), token)
            activeCount = res
            message = "Count recorded — review and post"
            return true
        } catch (e: Exception) {
            error = e.message ?: "Could not record count"
            return false
        } finally {
            busy = false
        }
    }

    /** Posts the recorded count — ledger movements + variance snapshot in one transaction. */
    suspend fun postCount(): Boolean {
        val count = activeCount ?: run {
            error = "No open count"
            return false
        }
        busy = true
        error = null
        try {
            api.post("/counts/${count.getString("id")}/post", JSONObject(), token)
            message = "Count posted to the ledger"
            activeCount = null
            countVariants = emptyList()
            return true
        } catch (e: Exception) {
            error = e.message ?: "Could not post count"
            return false
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

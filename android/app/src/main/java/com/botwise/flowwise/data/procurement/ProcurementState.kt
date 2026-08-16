package com.botwise.flowwise.data.procurement

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.remote.ApiClient
import org.json.JSONObject

/**
 * Procurement & intelligence (Phase 3 UI on top of the Phase 3 backend):
 * explainable reorder suggestions and the suggestion → purchase order flow.
 *
 * All reads/writes here are ONLINE: a PO must exist server-side before it can
 * be sent or received against (the GRN receipt path is what moves stock), so
 * there is no offline outbox variant for PO creation. Reorder evaluation is
 * server-computed from the ledger + demand window.
 */
class ProcurementState(
    private val api: ApiClient,
    private val auth: AuthManager,
) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    var suggestions by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var purchaseOrders by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    private val token: String
        get() = auth.accessToken ?: throw IllegalStateException("Not logged in")

    private val branchId: String?
        get() = auth.selectedBranchId

    /** Runs the evaluator for the selected branch and reloads the open set. */
    suspend fun evaluate() {
        val branch = branchId ?: run {
            error = "No branch selected"
            return
        }
        busy = true
        error = null
        try {
            val res = api.post("/reorder/evaluate", JSONObject().put("branchId", branch), token)
            message = "Evaluation: ${res.optInt("created", 0)} suggestion(s)"
            loadSuggestions()
        } catch (e: Exception) {
            error = e.message ?: "Could not evaluate reorder rules"
        } finally {
            busy = false
        }
    }

    suspend fun loadSuggestions() {
        val branch = branchId ?: run {
            error = "No branch selected"
            return
        }
        busy = true
        error = null
        try {
            val res = api.get("/reorder/suggestions?branchId=$branch&status=open", token)
            val arr = res.optJSONArray("suggestions")
            suggestions = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load suggestions"
        } finally {
            busy = false
        }
    }

    suspend fun dismissSuggestion(id: String) {
        busy = true
        error = null
        try {
            api.post("/reorder/suggestions/$id/dismiss", JSONObject(), token)
            suggestions = suggestions.filterNot { it.optString("id") == id }
            message = "Suggestion dismissed"
        } catch (e: Exception) {
            error = e.message ?: "Could not dismiss suggestion"
        } finally {
            busy = false
        }
    }

    /**
     * Converts an open suggestion into a draft PO (one line). Replaying the
     * same client_operation_id resolves to the same PO (Invariant 4).
     */
    suspend fun createPoFromSuggestion(suggestion: JSONObject, supplierId: String?, expectedDelivery: String?): Boolean {
        val branch = branchId ?: run {
            error = "No branch selected"
            return false
        }
        busy = true
        error = null
        try {
            val body = JSONObject()
                .put("branchId", branch)
                .put("suggestionId", suggestion.optString("id"))
            supplierId?.let { if (it.isNotBlank()) body.put("supplierId", it) }
            expectedDelivery?.let { if (it.isNotBlank()) body.put("expectedDelivery", it) }
            val res = api.post("/purchase-orders", body, token)
            suggestions = suggestions.filterNot { it.optString("id") == suggestion.optString("id") }
            message = "Draft ${res.optString("documentNo", "")} created — send it to the supplier"
            return true
        } catch (e: Exception) {
            error = e.message ?: "Could not create purchase order"
            return false
        } finally {
            busy = false
        }
    }

    suspend fun loadPurchaseOrders() {
        val branch = branchId ?: run {
            error = "No branch selected"
            return
        }
        busy = true
        error = null
        try {
            val res = api.get("/purchase-orders?branchId=$branch", token)
            val arr = res.optJSONArray("purchaseOrders")
            purchaseOrders = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load purchase orders"
        } finally {
            busy = false
        }
    }

    /** Sends a draft PO to the supplier — the owner/branch-manager approval step. */
    suspend fun sendPo(id: String) {
        busy = true
        error = null
        try {
            api.post("/purchase-orders/$id/send", JSONObject(), token)
            purchaseOrders = purchaseOrders.map {
                if (it.optString("id") == id) it.put("status", "sent") else it
            }
            message = "PO sent to the supplier"
        } catch (e: Exception) {
            error = e.message ?: "Could not send purchase order"
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

package com.botwise.flowwise.data.customers

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.OutboxDao
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.remote.ApiClient
import java.util.UUID
import org.json.JSONObject

/**
 * Customer accounts (Phase 5): the debtor master with balances, credit
 * limits, and statements. Creating an account is an online write (the till
 * needs the id back for credit sales); settlements are OFFLINE-FIRST —
 * queued to outbox_operations as `customer.settle` and flushed with
 * everything else on reconnect, replay-safe by client_operation_id.
 */
class CustomersState(
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

    var customers by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    /** Statement entries for the customer currently viewed (newest first). */
    var statementEntries by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var statementCustomer by mutableStateOf<JSONObject?>(null)
        private set

    private val token: String
        get() = auth.accessToken ?: throw IllegalStateException("Not logged in")

    suspend fun load() {
        busy = true
        error = null
        try {
            val res = api.get("/customers", token)
            val arr = res.optJSONArray("customers")
            customers = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load customers"
        } finally {
            busy = false
        }
    }

    /** Creates a customer account (name required; creditLimit "0" = no credit). */
    suspend fun create(name: String, phone: String, email: String, creditLimit: String): Boolean {
        if (name.isBlank()) {
            error = "Name is required"
            return false
        }
        busy = true
        error = null
        try {
            val body = JSONObject().put("name", name.trim())
            if (phone.isNotBlank()) body.put("phone", phone.trim())
            if (email.isNotBlank()) body.put("email", email.trim())
            if (creditLimit.isNotBlank()) body.put("creditLimit", creditLimit.trim())
            api.post("/customers", body, token)
            message = "Customer account created"
            load()
            return true
        } catch (e: Exception) {
            error = e.message ?: "Could not create the customer"
            return false
        } finally {
            busy = false
        }
    }

    /**
     * Records a payment against the account — OFFLINE-FIRST. The op flushes
     * through POST /v1/outbox as `customer.settle`; the server dedupes on
     * client_operation_id, so a retried flush never double-credits.
     */
    suspend fun queueSettlement(customerId: String, amount: String, notes: String): Boolean {
        val branchId = auth.selectedBranchId ?: run {
            error = "No branch selected"
            return false
        }
        val parsed = amount.toBigDecimalOrNull()
        if (parsed == null || parsed <= java.math.BigDecimal.ZERO) {
            error = "Enter a positive payment amount"
            return false
        }
        val clientOperationId = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("customerId", customerId)
            .put("branchId", branchId)
            .put("amount", parsed.toPlainString())
        if (notes.isNotBlank()) payload.put("notes", notes.trim())

        outboxDao.insert(
            OutboxOperationEntity(
                clientOperationId = clientOperationId,
                opType = "customer.settle",
                payloadJson = payload.toString(),
                idempotencyKey = clientOperationId,
            ),
        )
        message = "Payment queued — it syncs when the network returns"
        return true
    }

    /** Loads the statement (every ledger entry) for a customer. */
    suspend fun loadStatement(customer: JSONObject) {
        busy = true
        error = null
        try {
            val res = api.get("/customers/${customer.optString("id")}/statement", token)
            val arr = res.optJSONArray("entries")
            statementEntries = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
            statementCustomer = customer
        } catch (e: Exception) {
            error = e.message ?: "Could not load the statement"
        } finally {
            busy = false
        }
    }

    fun dismissStatement() {
        statementCustomer = null
        statementEntries = emptyList()
    }

    fun dismissError() {
        error = null
    }

    fun dismissMessage() {
        message = null
    }
}

/** Plain view-model of a customer row for the list UI. */
data class CustomerRow(
    val id: String,
    val name: String,
    val phone: String,
    val email: String,
    val balance: String,
    val creditLimit: String,
    val isActive: Boolean,
)

fun customerFromJson(o: JSONObject): CustomerRow = CustomerRow(
    id = o.optString("id"),
    name = o.optString("name"),
    phone = o.optString("phone"),
    email = o.optString("email"),
    balance = o.optString("balance", "0"),
    creditLimit = o.optString("creditLimit", "0"),
    isActive = o.optBoolean("isActive", true),
)

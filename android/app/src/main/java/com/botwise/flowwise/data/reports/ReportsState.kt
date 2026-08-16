package com.botwise.flowwise.data.reports

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.remote.ApiClient
import java.time.Instant
import java.time.temporal.ChronoUnit
import org.json.JSONObject

/** Period presets for the reports screen. */
enum class ReportPeriod(val label: String, val days: Int) {
    TODAY("Today", 1),
    WEEK("7 days", 7),
    MONTH("30 days", 30),
}

/**
 * Reports (Phase 5): read-only analytics over the selected branch — sales
 * summary + tender mix, on-hand stock valuation at latest landed cost, and
 * top products by revenue. All server-computed from the ledgers.
 */
class ReportsState(
    private val api: ApiClient,
    private val auth: AuthManager,
) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var period by mutableStateOf(ReportPeriod.TODAY)
        private set

    var summary by mutableStateOf<JSONObject?>(null)
        private set
    var valuation by mutableStateOf<JSONObject?>(null)
        private set
    var topProducts by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    private val token: String
        get() = auth.accessToken ?: throw IllegalStateException("Not logged in")

    private val branchId: String?
        get() = auth.selectedBranchId

    private fun range(): Pair<String, String> {
        val now = Instant.now()
        val from = now.minus(period.days.toLong() - 1, ChronoUnit.DAYS)
            .truncatedTo(ChronoUnit.DAYS)
            .toString()
        val to = now.plus(1, ChronoUnit.DAYS).truncatedTo(ChronoUnit.DAYS).toString()
        return from to to
    }

    suspend fun selectPeriod(p: ReportPeriod) {
        if (p == period) return
        period = p
        load()
    }

    suspend fun load() {
        val branch = branchId ?: run {
            error = "No branch selected"
            return
        }
        val (from, to) = range()
        busy = true
        error = null
        try {
            val base = "?branchId=$branch&from=$from&to=$to"
            summary = api.get("/reports/sales-summary$base", token)
            valuation = api.get("/reports/stock-valuation$base", token)
            val top = api.get("/reports/top-products$base&limit=10", token)
            val arr = top.optJSONArray("rows")
            topProducts = (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load reports"
        } finally {
            busy = false
        }
    }

    fun dismissError() {
        error = null
    }
}

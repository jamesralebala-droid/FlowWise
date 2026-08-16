package com.botwise.flowwise.ui.reports

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.pos.formatMoney
import com.botwise.flowwise.data.reports.ReportPeriod
import com.botwise.flowwise.data.reports.ReportsState
import java.math.BigDecimal
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reports (Phase 5): sales summary + tender mix, stock valuation at landed
 * cost, and top products — server-computed from the ledgers, read-only here.
 */
@Composable
fun ReportsScreen(
    modifier: Modifier = Modifier,
    state: ReportsState,
) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { state.load() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ReportPeriod.entries.forEach { p ->
                FilterChip(
                    selected = state.period == p,
                    onClick = { scope.launch { state.selectPeriod(p) } },
                    label = { Text(p.label) },
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        state.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = state::dismissError) { Text("Dismiss") }
        }
        if (state.busy && state.summary == null) {
            Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { SummaryCard(state.summary) }
                item { ValuationCard(state.valuation) }
                item { TopProductsCard(state.topProducts) }
            }
        }
    }
}

@Composable
private fun SummaryCard(summary: JSONObject?) {
    val totals = summary?.optJSONObject("totals")
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Sales summary", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (totals == null) {
                Text("No sales in this period.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            StatRow("Sales", totals.optString("salesCount", "0"))
            StatRow("Gross total", formatMoney(BigDecimal(totals.optString("total", "0"))))
            StatRow("Refunds", formatMoney(BigDecimal(totals.optString("refundTotal", "0"))))
            StatRow("Net total", formatMoney(BigDecimal(totals.optString("netTotal", "0"))))
            StatRow("Average sale", formatMoney(BigDecimal(totals.optString("averageSale", "0"))))
            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))
            val tenders = summary.optJSONArray("tenders") ?: JSONArray()
            (0 until tenders.length()).forEach { i ->
                val t = tenders.getJSONObject(i)
                StatRow(
                    t.optString("tenderType", "").replace("_", " ").replaceFirstChar { it.uppercase() },
                    "${formatMoney(BigDecimal(t.optString("amount", "0")))} · ${t.optString("count", "0")}",
                )
            }
        }
    }
}

@Composable
private fun ValuationCard(valuation: JSONObject?) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Stock valuation", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (valuation == null) {
                Text("No stock on hand.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            val rows = valuation.optJSONArray("rows") ?: JSONArray()
            (0 until rows.length()).forEach { i ->
                val r = rows.getJSONObject(i)
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(r.optString("branchName", "Branch"), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text(
                        "${r.optString("variants", "0")} items · ${formatMoney(BigDecimal(r.optString("value", "0")))}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            HorizontalDivider()
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth()) {
                Text("Total", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(formatMoney(BigDecimal(valuation.optString("total", "0"))), style = MaterialTheme.typography.titleSmall)
            }
        }
    }
}

@Composable
private fun TopProductsCard(products: List<JSONObject>) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Top products by revenue", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (products.isEmpty()) {
                Text("No sales in this period.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            products.forEach { p ->
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Row(Modifier.fillMaxWidth()) {
                        Text(
                            "${p.optString("productName", "")} · ${p.optString("variantName", "")}",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(formatMoney(BigDecimal(p.optString("revenue", "0"))), style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        "${p.optString("unitsSold", "0")} units",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

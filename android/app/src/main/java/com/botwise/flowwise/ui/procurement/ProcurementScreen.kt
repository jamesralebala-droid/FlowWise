package com.botwise.flowwise.ui.procurement

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.procurement.ProcurementState
import kotlinx.coroutines.launch
import org.json.JSONObject

private enum class ProcurementTab(val label: String) {
    SUGGESTIONS("Suggestions"),
    ORDERS("Orders"),
}

@Composable
fun ProcurementScreen(
    modifier: Modifier = Modifier,
    state: ProcurementState,
) {
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(ProcurementTab.SUGGESTIONS) }
    var convertTarget by remember { mutableStateOf<JSONObject?>(null) }
    var expectedDelivery by remember { mutableStateOf("") }

    Column(modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = tab.ordinal) {
            ProcurementTab.entries.forEach { t ->
                Tab(selected = tab == t, onClick = { tab = t }, text = { Text(t.label) })
            }
        }
        state.error?.let { message ->
            Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
            TextButton(onClick = state::dismissError) { Text("Dismiss") }
        }
        state.message?.let { message ->
            Text(message, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(12.dp))
            TextButton(onClick = state::dismissMessage) { Text("Dismiss") }
        }

        when (tab) {
            ProcurementTab.SUGGESTIONS -> SuggestionsTab(state, scope, onConvert = { convertTarget = it })
            ProcurementTab.ORDERS -> OrdersTab(state, scope)
        }
    }

    convertTarget?.let { suggestion ->
        AlertDialog(
            onDismissRequest = { convertTarget = null },
            title = { Text("Create purchase order") },
            text = {
                Column {
                    Text(
                        "${suggestion.optString("productName")} · ${suggestion.optString("variantName")}",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        "Suggested ${suggestion.optString("suggestedQuantity")} — supplier: ${suggestion.optString("supplierName").ifBlank { "auto" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = expectedDelivery,
                        onValueChange = { expectedDelivery = it },
                        label = { Text("Expected delivery (YYYY-MM-DD, optional)") },
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val target = suggestion
                        convertTarget = null
                        scope.launch {
                            state.createPoFromSuggestion(
                                target,
                                target.optString("suggestedSupplierId").ifEmpty { null },
                                expectedDelivery,
                            )
                        }
                        expectedDelivery = ""
                    },
                    enabled = !state.busy,
                ) { Text("Create draft") }
            },
            dismissButton = {
                TextButton(onClick = { convertTarget = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun SuggestionsTab(
    state: ProcurementState,
    scope: kotlinx.coroutines.CoroutineScope,
    onConvert: (JSONObject) -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Button(
            onClick = { scope.launch { state.evaluate() } },
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) { Text("Run reorder evaluation") }
        Spacer(Modifier.height(4.dp))
        Text(
            "Suggestions are explainable: current stock vs reorder point, demand, lead time.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        if (state.suggestions.isEmpty()) {
            Text(
                "No open suggestions — evaluate to generate them.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.suggestions, key = { it.optString("id") }) { suggestion ->
                    SuggestionCard(
                        suggestion = suggestion,
                        busy = state.busy,
                        onConvert = { onConvert(suggestion) },
                        onDismiss = { scope.launch { state.dismissSuggestion(suggestion.optString("id")) } },
                    )
                }
            }
        }
    }
}

@Composable
private fun SuggestionCard(
    suggestion: JSONObject,
    busy: Boolean,
    onConvert: () -> Unit,
    onDismiss: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Text(
                "${suggestion.optString("productName")} · ${suggestion.optString("variantName")}",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                "Stock ${suggestion.optString("currentStock")} · reorder point ${suggestion.optString("reorderPoint")}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "Suggest ordering ${suggestion.optString("suggestedQuantity")}",
                style = MaterialTheme.typography.titleMedium,
            )
            if (suggestion.optString("supplierName").isNotBlank()) {
                Text(
                    "Supplier: ${suggestion.optString("supplierName")}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                suggestion.optString("reason"),
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onConvert, enabled = !busy, modifier = Modifier.weight(1f)) {
                    Text("Create PO")
                }
                TextButton(onClick = onDismiss, enabled = !busy) { Text("Dismiss") }
            }
        }
    }
}

@Composable
private fun OrdersTab(state: ProcurementState, scope: kotlinx.coroutines.CoroutineScope) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("Purchase orders", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = { scope.launch { state.loadPurchaseOrders() } }, enabled = !state.busy) {
                Text("Refresh")
            }
        }
        if (state.purchaseOrders.isEmpty()) {
            Text(
                "No purchase orders yet — create one from a suggestion.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.purchaseOrders, key = { it.optString("id") }) { po ->
                    PoCard(
                        po = po,
                        busy = state.busy,
                        onSend = { scope.launch { state.sendPo(po.optString("id")) } },
                    )
                }
            }
        }
    }
}

@Composable
private fun PoCard(po: JSONObject, busy: Boolean, onSend: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(12.dp)) {
            Column(Modifier.weight(1f)) {
                Text(po.optString("documentNo"), style = MaterialTheme.typography.titleSmall)
                Text(
                    "${po.optString("supplierName")} · ${po.optString("branchName")}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "${po.optString("totalQuantity")} ordered / ${po.optString("receivedQuantity")} received",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                Text(
                    po.optString("status").replace("_", " "),
                    style = MaterialTheme.typography.labelMedium,
                    color = when (po.optString("status")) {
                        "draft" -> MaterialTheme.colorScheme.secondary
                        "sent" -> MaterialTheme.colorScheme.primary
                        "received" -> MaterialTheme.colorScheme.tertiary
                        "cancelled" -> MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                if (po.optString("status") == "draft") {
                    Spacer(Modifier.height(6.dp))
                    TextButton(onClick = onSend, enabled = !busy) { Text("Send") }
                }
            }
        }
    }
}

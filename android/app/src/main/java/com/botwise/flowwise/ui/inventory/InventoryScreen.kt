package com.botwise.flowwise.ui.inventory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.inventory.AdjustmentLineDraft
import com.botwise.flowwise.data.inventory.GrnLineDraft
import com.botwise.flowwise.data.inventory.InventoryState
import com.botwise.flowwise.data.inventory.TransferLineDraft
import com.botwise.flowwise.data.local.VariantDao
import com.botwise.flowwise.data.local.VariantPickerRow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private enum class InventoryTab(val label: String) {
    STOCK("Stock"),
    RECEIVE("Receive"),
    COUNT("Count"),
    TRANSFER("Transfer"),
    ADJUST("Adjust"),
}

@Composable
fun InventoryScreen(
    modifier: Modifier = Modifier,
    state: InventoryState,
    variantDao: VariantDao,
    authManager: AuthManager,
) {
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(InventoryTab.STOCK) }

    // Catalogue for the line pickers (Room-backed — works offline).
    val pickerState by produceState<List<VariantPickerRow>>(emptyList(), variantDao) {
        value = variantDao.picker().first()
    }

    // Branches for the transfer destination (from /me, online).
    val meState by produceState<JSONArray?>(null, authManager) {
        value = runCatching { authManager.me().optJSONArray("branches") }.getOrNull()
    }

    // Form state lives here so switching tabs never loses a draft.
    var grnLines by remember { mutableStateOf<List<GrnLineDraft>>(emptyList()) }
    var grnSupplier by remember { mutableStateOf<String?>(null) }
    var grnNotes by remember { mutableStateOf("") }

    var transferLines by remember { mutableStateOf<List<TransferLineDraft>>(emptyList()) }
    var transferTo by remember { mutableStateOf<String?>(null) }
    var transferNotes by remember { mutableStateOf("") }

    var adjustmentLines by remember { mutableStateOf<List<AdjustmentLineDraft>>(emptyList()) }
    var adjustmentType by remember { mutableStateOf("increase") }
    var adjustmentReason by remember { mutableStateOf("") }
    var adjustmentNotes by remember { mutableStateOf("") }

    var countVariants by remember { mutableStateOf<List<String>>(emptyList()) }
    var countNotes by remember { mutableStateOf("") }

    Column(modifier.fillMaxSize()) {
        if (state.pendingOps > 0) {
            Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                Text(
                    "${state.pendingOps} operation(s) queued offline — will sync when the network returns",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(12.dp),
                )
            }
        }
        TabRow(selectedTabIndex = tab.ordinal) {
            InventoryTab.entries.forEach { t ->
                Tab(
                    selected = tab == t,
                    onClick = { tab = t },
                    text = { Text(t.label) },
                )
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
            InventoryTab.STOCK -> StockTab(state, scope)
            InventoryTab.RECEIVE -> GrnTab(
                state = state,
                picker = pickerState,
                lines = grnLines,
                onLines = { grnLines = it },
                supplier = grnSupplier,
                onSupplier = { grnSupplier = it },
                notes = grnNotes,
                onNotes = { grnNotes = it },
                scope = scope,
            )
            InventoryTab.COUNT -> CountTab(
                state = state,
                picker = pickerState,
                variants = countVariants,
                onVariants = { countVariants = it },
                notes = countNotes,
                onNotes = { countNotes = it },
                scope = scope,
            )
            InventoryTab.TRANSFER -> TransferTab(
                state = state,
                picker = pickerState,
                branches = meState,
                currentBranchId = authManager.selectedBranchId,
                lines = transferLines,
                onLines = { transferLines = it },
                to = transferTo,
                onTo = { transferTo = it },
                notes = transferNotes,
                onNotes = { transferNotes = it },
                scope = scope,
            )
            InventoryTab.ADJUST -> AdjustTab(
                state = state,
                picker = pickerState,
                lines = adjustmentLines,
                onLines = { adjustmentLines = it },
                type = adjustmentType,
                onType = { adjustmentType = it },
                reason = adjustmentReason,
                onReason = { adjustmentReason = it },
                notes = adjustmentNotes,
                onNotes = { adjustmentNotes = it },
                scope = scope,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Stock tab
// ---------------------------------------------------------------------------

@Composable
private fun StockTab(state: InventoryState, scope: kotlinx.coroutines.CoroutineScope) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Low stock", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            OutlinedButton(
                onClick = { scope.launch { state.loadStock() } },
                enabled = !state.busy,
            ) { Text("Refresh") }
        }
        Spacer(Modifier.height(8.dp))
        if (state.busy && state.balances.isEmpty()) {
            Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (state.lowStock.isEmpty()) {
            Text(
                "No items below their reorder level.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.lowStock, key = { it.optString("variantId") }) { item ->
                    LowStockRow(item)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Text("Balances", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        if (state.balances.isEmpty()) {
            Text("Nothing synced yet — pull to refresh.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(state.balances, key = { it.optString("variantId") }) { row ->
                    Row(Modifier.fillMaxWidth()) {
                        Text(
                            "${row.optString("productName")} · ${row.optString("variantName")}",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(row.optString("quantityOnHand"), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun LowStockRow(item: JSONObject) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${item.optString("productName")} · ${item.optString("variantName")}",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    "On hand ${item.optString("quantityOnHand")} — reorder level ${item.optString("reorderLevel")}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "Short ${item.optString("shortage")}",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// GRN tab (offline-queued)
// ---------------------------------------------------------------------------

@Composable
private fun GrnTab(
    state: InventoryState,
    picker: List<VariantPickerRow>,
    lines: List<GrnLineDraft>,
    onLines: (List<GrnLineDraft>) -> Unit,
    supplier: String?,
    onSupplier: (String?) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("Receive goods (GRN)", style = MaterialTheme.typography.titleMedium)
        Text(
            "Queued locally and posted to the ledger on reconnect.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Text("Supplier", style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = supplier == null, onClick = { onSupplier(null) }, label = { Text("None") })
            state.suppliers.forEach { s ->
                FilterChip(
                    selected = supplier == s.optString("id"),
                    onClick = { onSupplier(s.optString("id")) },
                    label = { Text(s.optString("name")) },
                )
            }
        }
        Spacer(Modifier.height(12.dp))

        if (lines.isEmpty()) {
            Text("No lines yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            lines.forEachIndexed { i, line ->
                GrnLineRow(line, onRemove = { onLines(lines.filterIndexed { idx, _ -> idx != i }) }) { updated ->
                    onLines(lines.mapIndexed { idx, l -> if (idx == i) updated else l })
                }
                HorizontalDivider(Modifier.padding(vertical = 6.dp))
            }
        }

        AddLineButton(picker) { picked ->
            onLines(
                lines + GrnLineDraft(
                    variantId = picked.id,
                    variantName = "${picked.productName} · ${picked.variantName}",
                    quantity = "1",
                    unitCost = "",
                    batchNo = "",
                    expiryDate = "",
                ),
            )
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = notes,
            onValueChange = onNotes,
            label = { Text("Notes (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = {
                scope.launch {
                    if (state.queueGrn(supplier, notes, lines)) onLines(emptyList())
                }
            },
            enabled = lines.isNotEmpty() && !state.busy,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) { Text("Queue GRN (works offline)") }
    }
}

@Composable
private fun GrnLineRow(line: GrnLineDraft, onRemove: () -> Unit, onChange: (GrnLineDraft) -> Unit) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(line.variantName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onRemove) { Text("−") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = line.quantity,
                onValueChange = { onChange(line.copy(quantity = it)) },
                label = { Text("Qty") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = line.unitCost,
                onValueChange = { onChange(line.copy(unitCost = it)) },
                label = { Text("Unit cost") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = line.batchNo,
                onValueChange = { onChange(line.copy(batchNo = it)) },
                label = { Text("Batch no") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = line.expiryDate,
                onValueChange = { onChange(line.copy(expiryDate = it)) },
                label = { Text("Expiry (YYYY-MM-DD)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Count tab (online: open → record → post)
// ---------------------------------------------------------------------------

@Composable
private fun CountTab(
    state: InventoryState,
    picker: List<VariantPickerRow>,
    variants: List<String>,
    onVariants: (List<String>) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("Stock count", style = MaterialTheme.typography.titleMedium)
        Text(
            "Blind count: pick the variants, record what you actually see, post to the ledger.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        val active = state.activeCount
        if (active == null) {
            if (picker.isEmpty()) {
                Text("Catalogue not synced yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(picker, key = { it.id }) { row ->
                        val checked = variants.contains(row.id)
                        Card(Modifier.fillMaxWidth().clickable {
                            onVariants(if (checked) variants - row.id else variants + row.id)
                        }) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(if (checked) "☑" else "☐", style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.width(10.dp))
                                Column {
                                    Text("${row.productName} · ${row.variantName}", style = MaterialTheme.typography.bodyMedium)
                                    row.sku?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = notes,
                    onValueChange = onNotes,
                    label = { Text("Notes (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        val selected = picker
                            .filter { variants.contains(it.id) }
                            .map { it.id to "${it.productName} · ${it.variantName}" }
                        scope.launch { state.openCount(selected, notes) }
                    },
                    enabled = variants.isNotEmpty() && !state.busy,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) { Text("Open count") }
            }
        } else {
            Text(
                "Count ${active.optString("documentNo", "").ifBlank { active.optString("id") }} — record quantities",
                style = MaterialTheme.typography.titleSmall,
            )
            Spacer(Modifier.height(8.dp))
            state.countVariants.forEachIndexed { i, row ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                    Text(
                        row.optString("variantName").ifBlank { "Variant ${row.optString("variantId")}" },
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = row.optString("quantity", ""),
                        onValueChange = { value -> state.updateCountQuantity(i, value) },
                        label = { Text("Counted") },
                        singleLine = true,
                        modifier = Modifier.width(140.dp),
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = { scope.launch { state.recordCount() } },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Record count") }
            Button(
                onClick = { scope.launch { state.postCount() } },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Post to ledger") }
        }
    }
}

// ---------------------------------------------------------------------------
// Transfer tab (offline-queued)
// ---------------------------------------------------------------------------

@Composable
private fun TransferTab(
    state: InventoryState,
    picker: List<VariantPickerRow>,
    branches: JSONArray?,
    currentBranchId: String?,
    lines: List<TransferLineDraft>,
    onLines: (List<TransferLineDraft>) -> Unit,
    to: String?,
    onTo: (String?) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("Branch transfer", style = MaterialTheme.typography.titleMedium)
        Text(
            "Moves stock out of the selected branch. Queued offline.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Text("Destination branch", style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val otherBranches = branches?.let { arr ->
                (0 until arr.length())
                    .map { arr.getJSONObject(it) }
                    .filter { it.optString("id") != currentBranchId }
            }.orEmpty()
            if (otherBranches.isEmpty()) {
                Text("No other branch available.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                otherBranches.forEach { b ->
                    val id = b.optString("id")
                    FilterChip(
                        selected = to == id,
                        onClick = { onTo(id) },
                        label = { Text(b.optString("name")) },
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        if (lines.isEmpty()) {
            Text("No lines yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            lines.forEach { line ->
                TransferLineRow(line) { updated ->
                    onLines(lines.map { if (it.variantId == line.variantId) updated else it })
                }
                HorizontalDivider(Modifier.padding(vertical = 6.dp))
            }
        }

        AddLineButton(picker) { picked ->
            onLines(
                lines + TransferLineDraft(
                    variantId = picked.id,
                    variantName = "${picked.productName} · ${picked.variantName}",
                    quantity = "1",
                ),
            )
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = notes,
            onValueChange = onNotes,
            label = { Text("Notes (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = {
                scope.launch {
                    if (state.queueTransfer(to ?: "", notes, lines)) onLines(emptyList())
                }
            },
            enabled = lines.isNotEmpty() && to != null && !state.busy,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) { Text("Queue transfer (works offline)") }
    }
}

@Composable
private fun TransferLineRow(line: TransferLineDraft, onChange: (TransferLineDraft) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(line.variantName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        OutlinedTextField(
            value = line.quantity,
            onValueChange = { onChange(line.copy(quantity = it)) },
            label = { Text("Qty") },
            singleLine = true,
            modifier = Modifier.width(120.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// Adjustment tab (offline-queued)
// ---------------------------------------------------------------------------

@Composable
private fun AdjustTab(
    state: InventoryState,
    picker: List<VariantPickerRow>,
    lines: List<AdjustmentLineDraft>,
    onLines: (List<AdjustmentLineDraft>) -> Unit,
    type: String,
    onType: (String) -> Unit,
    reason: String,
    onReason: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("Stock adjustment", style = MaterialTheme.typography.titleMedium)
        Text(
            "An auditable increase/decrease with a mandatory reason. Queued offline.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = type == "increase", onClick = { onType("increase") }, label = { Text("Increase") })
            FilterChip(selected = type == "decrease", onClick = { onType("decrease") }, label = { Text("Decrease") })
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = reason,
            onValueChange = onReason,
            label = { Text("Reason (required)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))

        if (lines.isEmpty()) {
            Text("No lines yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            lines.forEach { line ->
                AdjustLineRow(line) { updated ->
                    onLines(lines.map { if (it.variantId == line.variantId) updated else it })
                }
                HorizontalDivider(Modifier.padding(vertical = 6.dp))
            }
        }

        AddLineButton(picker) { picked ->
            onLines(
                lines + AdjustmentLineDraft(
                    variantId = picked.id,
                    variantName = "${picked.productName} · ${picked.variantName}",
                    quantity = "1",
                    unitCost = "",
                ),
            )
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = notes,
            onValueChange = onNotes,
            label = { Text("Notes (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = {
                scope.launch {
                    if (state.queueAdjustment(type, reason, notes, lines)) {
                        onLines(emptyList())
                        onReason("")
                    }
                }
            },
            enabled = lines.isNotEmpty() && reason.isNotBlank() && !state.busy,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) { Text("Queue adjustment (works offline)") }
    }
}

@Composable
private fun AdjustLineRow(line: AdjustmentLineDraft, onChange: (AdjustmentLineDraft) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(line.variantName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        OutlinedTextField(
            value = line.quantity,
            onValueChange = { onChange(line.copy(quantity = it)) },
            label = { Text("Qty") },
            singleLine = true,
            modifier = Modifier.width(100.dp),
        )
        OutlinedTextField(
            value = line.unitCost,
            onValueChange = { onChange(line.copy(unitCost = it)) },
            label = { Text("Cost") },
            singleLine = true,
            modifier = Modifier.width(100.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// Shared: variant picker
// ---------------------------------------------------------------------------

@Composable
private fun AddLineButton(picker: List<VariantPickerRow>, onPick: (VariantPickerRow) -> Unit) {
    var showPicker by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { showPicker = true }, modifier = Modifier.fillMaxWidth()) {
        Text("+ Add line")
    }
    if (showPicker) {
        AlertDialog(
            onDismissRequest = { showPicker = false },
            title = { Text("Add variant") },
            text = {
                if (picker.isEmpty()) {
                    Text("Catalogue not synced yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    LazyColumn {
                        items(picker, key = { it.id }) { row ->
                            Column(Modifier.fillMaxWidth().clickable {
                                onPick(row)
                                showPicker = false
                            }.padding(vertical = 10.dp)) {
                                Text("${row.productName} · ${row.variantName}", style = MaterialTheme.typography.bodyMedium)
                                row.sku?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showPicker = false }) { Text("Cancel") }
            },
        )
    }
}

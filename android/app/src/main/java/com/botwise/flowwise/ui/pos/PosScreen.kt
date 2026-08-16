package com.botwise.flowwise.ui.pos

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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.pos.CartItem
import com.botwise.flowwise.data.pos.PosState
import com.botwise.flowwise.data.pos.formatMoney
import java.math.BigDecimal
import kotlinx.coroutines.launch

@Composable
fun PosScreen(
    modifier: Modifier = Modifier,
    state: PosState,
    onScan: () -> Unit,
    onSaleCompleted: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var showOpenShift by remember { mutableStateOf(false) }
    var showCashUp by remember { mutableStateOf(false) }
    var openingCash by remember { mutableStateOf("0") }
    var tender by remember { mutableStateOf("") }
    var declaredCash by remember { mutableStateOf("0") }
    var declaredCard by remember { mutableStateOf("0") }
    var declaredMobile by remember { mutableStateOf("0") }
    var declaredCredit by remember { mutableStateOf("0") }
    var declaredOther by remember { mutableStateOf("0") }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        ShiftBanner(
            state = state,
            onOpen = { showOpenShift = true },
            onCashUp = { showCashUp = true },
        )
        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        Text("Cart", style = MaterialTheme.typography.titleMedium)

        if (state.items.isEmpty()) {
            Text(
                "Cart is empty — scan a barcode to start",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 16.dp),
            )
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.items, key = { it.variantId }) { item ->
                    CartRow(item) { delta -> state.changeQuantity(item.variantId, delta) }
                }
            }
        }

        state.error?.let { message ->
            Spacer(Modifier.height(8.dp))
            Text(message, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = state::clearError) { Text("Dismiss") }
        }

        Spacer(Modifier.height(12.dp))
        Text("Total  ${formatMoney(state.total)}", style = MaterialTheme.typography.titleLarge)

        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = tender,
                onValueChange = { tender = it },
                label = { Text("Cash tendered") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(12.dp))
            val change = tender.toBigDecimalOrNull()?.subtract(state.total)
            Text(
                "Change\n${formatMoney(change ?: BigDecimal.ZERO)}",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                scope.launch {
                    state.completeSale(tender)
                    if (state.receipt != null) onSaleCompleted()
                }
            },
            enabled = state.items.isNotEmpty() && !state.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("Complete sale")
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onScan,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("Scan barcode")
        }
    }

    if (showOpenShift) {
        AlertDialog(
            onDismissRequest = { showOpenShift = false },
            title = { Text("Open shift") },
            text = {
                Column {
                    Text(
                        "Enter the opening float for this branch.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = openingCash,
                        onValueChange = { openingCash = it },
                        label = { Text("Opening cash") },
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showOpenShift = false
                        scope.launch { state.openShift(openingCash) }
                    },
                    enabled = !state.busy,
                ) { Text("Open") }
            },
            dismissButton = {
                TextButton(onClick = { showOpenShift = false }) { Text("Cancel") }
            },
        )
    }

    if (showCashUp) {
        AlertDialog(
            onDismissRequest = { showCashUp = false },
            title = { Text("Cash-up — close shift") },
            text = {
                Column {
                    TenderField("Cash", declaredCash, { declaredCash = it })
                    TenderField("Card", declaredCard, { declaredCard = it })
                    TenderField("Mobile money", declaredMobile, { declaredMobile = it })
                    TenderField("Credit", declaredCredit, { declaredCredit = it })
                    TenderField("Other", declaredOther, { declaredOther = it })
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Expected totals and variance are computed server-side.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showCashUp = false
                        scope.launch {
                            state.closeShift(
                                mapOf(
                                    "cash" to declaredCash,
                                    "card" to declaredCard,
                                    "mobileMoney" to declaredMobile,
                                    "credit" to declaredCredit,
                                    "other" to declaredOther,
                                ),
                            )
                        }
                    },
                    enabled = !state.busy,
                ) { Text("Close shift") }
            },
            dismissButton = {
                TextButton(onClick = { showCashUp = false }) { Text("Cancel") }
            },
        )
    }

    state.shiftResult?.let { result ->
        AlertDialog(
            onDismissRequest = state::dismissShiftResult,
            title = { Text(result.message) },
            text = {
                Column {
                    result.expectedTotal?.let { Text("Expected total  P $it") }
                    result.variance?.let {
                        Text(
                            "Variance  P $it",
                            color = if (it.startsWith("-")) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.primary
                            },
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = state::dismissShiftResult) { Text("OK") }
            },
        )
    }
}

@Composable
private fun ShiftBanner(
    state: PosState,
    onOpen: () -> Unit,
    onCashUp: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val shift = state.shift
            Column(Modifier.weight(1f)) {
                if (shift == null) {
                    Text("No open shift", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Open one before cashing up",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text("Shift open", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Ref ${shift.id.take(8)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (shift == null) {
                Button(onClick = onOpen) { Text("Open") }
            } else {
                TextButton(onClick = onCashUp) { Text("Cash-up") }
            }
        }
    }
}

@Composable
private fun CartRow(item: CartItem, onChangeQuantity: (Int) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(item.name, style = MaterialTheme.typography.titleSmall)
                Text(
                    "${formatMoney(BigDecimal(item.unitPrice))} each",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = { onChangeQuantity(-1) }) { Text("−") }
            Text(item.quantity.toPlainString(), style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { onChangeQuantity(1) }) { Text("+") }
            Spacer(Modifier.width(12.dp))
            Text(formatMoney(item.lineTotal), style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
private fun TenderField(label: String, value: String, onValueChange: (String) -> Unit) {
    Spacer(Modifier.height(4.dp))
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

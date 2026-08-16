package com.botwise.flowwise.ui.pos

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
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.botwise.flowwise.data.pos.TenderEntry
import com.botwise.flowwise.data.pos.formatMoney
import java.math.BigDecimal
import kotlinx.coroutines.launch

@Composable
fun PosScreen(
    modifier: Modifier = Modifier,
    state: PosState,
    pendingOps: Int,
    onOpenQueue: () -> Unit,
    onScan: () -> Unit,
    onSaleCompleted: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var showOpenShift by remember { mutableStateOf(false) }
    var showCashUp by remember { mutableStateOf(false) }
    var showCustomerPicker by remember { mutableStateOf(false) }
    var openingCash by remember { mutableStateOf("0") }
    var cashTender by remember { mutableStateOf("0") }
    var cardTender by remember { mutableStateOf("0") }
    var mobileTender by remember { mutableStateOf("0") }
    var creditTender by remember { mutableStateOf("0") }
    var emailTo by remember { mutableStateOf("") }
    var declaredCash by remember { mutableStateOf("0") }
    var declaredCard by remember { mutableStateOf("0") }
    var declaredMobile by remember { mutableStateOf("0") }
    var declaredCredit by remember { mutableStateOf("0") }
    var declaredOther by remember { mutableStateOf("0") }

    val cash = cashTender.toBigDecimalOrNull() ?: BigDecimal.ZERO
    val card = cardTender.toBigDecimalOrNull() ?: BigDecimal.ZERO
    val mobile = mobileTender.toBigDecimalOrNull() ?: BigDecimal.ZERO
    val credit = creditTender.toBigDecimalOrNull() ?: BigDecimal.ZERO
    val tendered = cash.add(card).add(mobile).add(credit)
    val change = tendered.subtract(state.total)
    val short = change < BigDecimal.ZERO
    val creditNeedsCustomer = credit > BigDecimal.ZERO && state.creditCustomerId == null
    val canComplete = state.items.isNotEmpty() && !state.busy && tendered > BigDecimal.ZERO && !short && !creditNeedsCustomer

    LaunchedEffect(Unit) { state.loadCustomers() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        ShiftBanner(
            state = state,
            onOpen = { showOpenShift = true },
            onCashUp = { showCashUp = true },
        )
        if (pendingOps > 0) {
            Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("$pendingOps operation(s) queued offline", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Will sync automatically when the network returns",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onOpenQueue) { Text("Sync queue") }
                }
            }
        }
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

        Spacer(Modifier.height(12.dp))
        Text("Tenders", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            QuickTenderButton("Exact") { cashTender = state.total.toPlainString() }
            QuickTenderButton("P20") { cashTender = "20" }
            QuickTenderButton("P50") { cashTender = "50" }
            QuickTenderButton("P100") { cashTender = "100" }
            QuickTenderButton("P200") { cashTender = "200" }
        }
        Spacer(Modifier.height(8.dp))
        TenderRow("Cash", cashTender, { cashTender = it })
        TenderRow("Card", cardTender, { cardTender = it })
        TenderRow("Mobile money", mobileTender, { mobileTender = it })
        TenderRow("Credit", creditTender, { creditTender = it })
        if (credit > BigDecimal.ZERO) {
            Spacer(Modifier.height(6.dp))
            CustomerPickerRow(state, onPick = { showCustomerPicker = true })
            if (creditNeedsCustomer) {
                Text(
                    "Select a customer account for the credit sale",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = emailTo,
            onValueChange = { emailTo = it },
            label = { Text("Email receipt to (optional)") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Tendered ${formatMoney(tendered)}",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            Text(
                if (short) "Short ${formatMoney(change.abs())}" else "Change ${formatMoney(change)}",
                style = MaterialTheme.typography.titleMedium,
                color = if (short) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                scope.launch {
                    state.completeSale(
                        listOf(
                            TenderEntry("cash", cashTender),
                            TenderEntry("card", cardTender),
                            TenderEntry("mobileMoney", mobileTender),
                            TenderEntry("credit", creditTender),
                        ),
                        customerId = if (credit > BigDecimal.ZERO) state.creditCustomerId else null,
                        emailTo = emailTo,
                    )
                    if (state.receipt != null) onSaleCompleted()
                }
            },
            enabled = canComplete,
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

    if (showCustomerPicker) {
        AlertDialog(
            onDismissRequest = { showCustomerPicker = false },
            title = { Text("Credit customer") },
            text = {
                if (state.customers.isEmpty()) {
                    Text(
                        "No customer accounts synced. Create one in Customers first.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    LazyColumn {
                        items(state.customers, key = { it.optString("id") }) { customer ->
                            Column(
                                Modifier.fillMaxWidth()
                                    .clickable {
                                        state.selectCreditCustomer(customer.optString("id"))
                                        showCustomerPicker = false
                                    }
                                    .padding(vertical = 10.dp),
                            ) {
                                Text(customer.optString("name"), style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    "Balance ${formatMoney(BigDecimal(customer.optString("balance", "0")))} · limit ${formatMoney(BigDecimal(customer.optString("creditLimit", "0")))} · ${customer.optString("phone", customer.optString("email", ""))}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            HorizontalDivider()
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showCustomerPicker = false }) { Text("Cancel") }
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

@Composable
private fun QuickTenderButton(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.weight(1f)) {
        Text(label)
    }
}

@Composable
private fun TenderRow(label: String, value: String, onValueChange: (String) -> Unit) {
    Spacer(Modifier.height(6.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(96.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Row that shows the selected credit customer (or prompts to pick one). */
@Composable
private fun CustomerPickerRow(state: PosState, onPick: () -> Unit) {
    val selected = state.customers.firstOrNull { it.optString("id") == state.creditCustomerId }
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onPick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (selected != null) selected.optString("name") else "Select credit customer…",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (selected != null) {
                    Text(
                        "Balance ${formatMoney(BigDecimal(selected.optString("balance", "0")))} — tap to change",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text("▾", style = MaterialTheme.typography.titleMedium)
        }
    }
}

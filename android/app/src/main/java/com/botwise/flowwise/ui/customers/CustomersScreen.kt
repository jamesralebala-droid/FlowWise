package com.botwise.flowwise.ui.customers

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.botwise.flowwise.data.customers.CustomerRow
import com.botwise.flowwise.data.customers.CustomersState
import com.botwise.flowwise.data.customers.customerFromJson
import com.botwise.flowwise.data.pos.formatMoney
import java.math.BigDecimal
import kotlinx.coroutines.launch

/**
 * Customer accounts (Phase 5): balances, credit limits, create-new, and per
 * account a statement + offline-queued settlement.
 */
@Composable
fun CustomersScreen(
    modifier: Modifier = Modifier,
    state: CustomersState,
) {
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<CustomerRow?>(null) }

    LaunchedEffect(Unit) { state.load() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Accounts", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            Button(onClick = { showCreate = true }, enabled = !state.busy) { Text("New customer") }
        }
        Text(
            "Balances come from the ledger — tap an account for its statement and payments.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        state.message?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            TextButton(onClick = state::dismissMessage) { Text("Dismiss") }
        }
        state.error?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = state::dismissError) { Text("Dismiss") }
        }

        if (state.customers.isEmpty() && !state.busy) {
            Text(
                "No customer accounts yet — create the first one.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 24.dp),
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.customers, key = { it.optString("id") }) { o ->
                    val row = customerFromJson(o)
                    Card(Modifier.fillMaxWidth().clickable { detail = row }) {
                        Row(
                            Modifier.fillMaxWidth().padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(row.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    listOf(row.phone, row.email).filter { it.isNotBlank() }.joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    formatMoney(BigDecimal(row.balance)),
                                    style = MaterialTheme.typography.titleMedium,
                                    color = if (BigDecimal(row.balance) > BigDecimal.ZERO) {
                                        MaterialTheme.colorScheme.error
                                    } else {
                                        MaterialTheme.colorScheme.primary
                                    },
                                )
                                Text(
                                    "limit ${formatMoney(BigDecimal(row.creditLimit))}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        CreateCustomerDialog(
            busy = state.busy,
            onCancel = { showCreate = false },
            onCreate = { name, phone, email, limit ->
                scope.launch {
                    if (state.create(name, phone, email, limit)) showCreate = false
                }
            },
        )
    }

    detail?.let { row ->
        CustomerDetailDialog(
            row = row,
            state = state,
            onDismiss = {
                detail = null
                state.dismissStatement()
            },
        )
    }
}

@Composable
private fun CreateCustomerDialog(
    busy: Boolean,
    onCancel: () -> Unit,
    onCreate: (String, String, String, String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("New customer account") },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text("Phone") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = limit,
                    onValueChange = { limit = it },
                    label = { Text("Credit limit (0 = no credit)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(name, phone, email, limit) }, enabled = !busy) {
                Text("Create")
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel) { Text("Cancel") }
        },
    )
}

@Composable
private fun CustomerDetailDialog(
    row: CustomerRow,
    state: CustomersState,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var settleAmount by remember { mutableStateOf("") }
    var settleNotes by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(row.id) {
        if (!loaded) {
            state.loadStatement(state.customers.first { it.optString("id") == row.id })
            loaded = true
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(row.name) },
        text = {
            Column {
                Text(
                    "Balance ${formatMoney(BigDecimal(row.balance))} of limit ${formatMoney(BigDecimal(row.creditLimit))}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (BigDecimal(row.balance) > BigDecimal.ZERO) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = settleAmount,
                    onValueChange = { settleAmount = it },
                    label = { Text("Payment amount (queues offline)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = settleNotes,
                    onValueChange = { settleNotes = it },
                    label = { Text("Notes (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            if (state.queueSettlement(row.id, settleAmount, settleNotes)) {
                                settleAmount = ""
                                settleNotes = ""
                            }
                        }
                    },
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Queue payment") }
                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(8.dp))
                Text("Statement", style = MaterialTheme.typography.titleSmall)
                if (state.statementEntries.isEmpty()) {
                    Text(
                        "No entries yet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    state.statementEntries.forEach { entry ->
                        val amount = BigDecimal(entry.optString("amount", "0"))
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    entry.optString("entryType", "").replaceFirstChar { it.uppercase() },
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Text(
                                    entry.optString("businessTime", "").take(16).replace("T", " "),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(
                                formatMoney(amount),
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (amount > BigDecimal.ZERO) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.primary
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}

package com.botwise.flowwise.ui.refunds

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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.refunds.RefundState
import com.botwise.flowwise.data.refunds.RefundableSale
import java.math.BigDecimal

private fun fmt(v: String): String {
    return runCatching { "P " + BigDecimal(v).setScale(2, java.math.RoundingMode.HALF_UP).toPlainString() }
        .getOrElse { v }
}

@Composable
fun RefundScreen(
    modifier: Modifier = Modifier,
    state: RefundState,
) {
    LaunchedEffect(Unit) {
        state.load()
    }

    val selected = state.selected
    Column(modifier.fillMaxSize().padding(16.dp)) {
        if (selected == null) {
            Text("Refunds", style = MaterialTheme.typography.titleLarge)
            Text(
                "Pick a completed sale to refund. A refund of a mobile-money sale pays the customer back to their wallet when it syncs.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))

            if (state.error != null) {
                Text(state.error!!, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
            }

            if (state.sales.isEmpty()) {
                Text(
                    if (state.busy) "Loading sales…" else "No sales yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn {
                    items(state.sales, key = { it.id }) { sale ->
                        SaleRow(sale, onClick = { state.select(sale) })
                        HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    }
                }
            }
        } else {
            Text("Refund sale", style = MaterialTheme.typography.titleLarge)
            Text(
                "Ref ${selected.clientOperationId.take(8).uppercase()} · ${fmt(selected.total)} · ${selected.tenders.joinToString(", ")}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))

            if (state.message != null) {
                Text(state.message!!, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(12.dp))
            }
            if (state.error != null) {
                Text(state.error!!, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
            }

            if (state.queuedOpId == null) {
                OutlinedTextField(
                    value = state.amount,
                    onValueChange = state::setAmount,
                    label = { Text("Refund amount (P)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.reason,
                    onValueChange = state::setReason,
                    label = { Text("Reason (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { state.queueRefund() },
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Queue refund (works offline)")
                }
            } else {
                Text(
                    "Refund ${state.queuedOpId!!.take(8)} queued. Check the Sync queue to flush it now.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
            }

            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = state::clearSelection,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Back to sales")
            }
        }
    }
}

@Composable
private fun SaleRow(sale: RefundableSale, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${sale.clientOperationId.take(8).uppercase()} · ${sale.tenders.joinToString(", ")}",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    runCatching { java.text.SimpleDateFormat("dd MMM HH:mm", java.util.Locale.getDefault()).format(java.util.Date(sale.businessTime)) }
                        .getOrElse { sale.businessTime },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(fmt(sale.total), style = MaterialTheme.typography.titleMedium)
                if (sale.mobileMoneyConfirmed) {
                    Text("mobile-money paid", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

package com.botwise.flowwise.ui.queue

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.local.OutboxOperationEntity
import com.botwise.flowwise.data.outbox.OutboxState
import kotlinx.coroutines.launch

/**
 * The offline queue at a glance: every operation saved on this till, its
 * status (pending / synced / failed), how many attempts it has taken, and a
 * manual "Sync now" that flushes through the same path as the background
 * worker. Sales, GRNs, transfers and adjustments are saved locally first and
 * pushed when connectivity returns — this screen is where you watch that
 * happen and force it early when the network is back.
 */
@Composable
fun OutboxScreen(
    modifier: Modifier = Modifier,
    state: OutboxState,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { state.load() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Text("Offline queue", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sales and stock operations are saved on this till first, then pushed when the network returns.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${state.pendingCount} pending · ${state.syncedCount} synced · ${state.failedCount} failed",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = { scope.launch { state.flushNow() } },
                enabled = !state.busy && state.pendingCount > 0,
            ) {
                Text(if (state.busy) "Syncing…" else "Sync now")
            }
        }

        state.error?.let { message ->
            Spacer(Modifier.height(8.dp))
            Text(message, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = state::dismissError) { Text("Dismiss") }
        }
        state.message?.let { message ->
            Spacer(Modifier.height(8.dp))
            Text(message, color = MaterialTheme.colorScheme.primary)
            TextButton(onClick = state::dismissMessage) { Text("Dismiss") }
        }
        if (state.failedCount > 0) {
            Spacer(Modifier.height(8.dp))
            Text(
                "Failed operations will not retry automatically — re-create them and contact support if needed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Spacer(Modifier.height(8.dp))
        if (state.busy && state.ops.isEmpty()) {
            Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (state.ops.isEmpty()) {
            Text("Nothing queued yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.ops, key = { it.id }) { op ->
                    OutboxRow(op)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = onDone,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            Text("Done")
        }
    }
}

@Composable
private fun OutboxRow(op: OutboxOperationEntity) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(op.status)
                Spacer(Modifier.width(8.dp))
                Text(op.opType, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(
                    ago(op.createdAt),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Ref ${op.clientOperationId.take(8).uppercase()} · ${op.attempts} attempt(s)",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                payloadPreview(op.payloadJson),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StatusDot(status: String) {
    val color = when (status) {
        "pending" -> MaterialTheme.colorScheme.tertiary
        "synced" -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.error
    }
    Box(Modifier.size(10.dp).background(color, CircleShape))
}

private fun ago(timestamp: Long): String {
    val minutes = (System.currentTimeMillis() - timestamp) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 24 -> "${minutes / 60}h ago"
        else -> "${minutes / (60 * 24)}d ago"
    }
}

private fun payloadPreview(json: String): String =
    json.replace(Regex("\\s+"), " ")

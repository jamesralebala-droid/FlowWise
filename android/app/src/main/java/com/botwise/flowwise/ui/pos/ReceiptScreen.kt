package com.botwise.flowwise.ui.pos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.pos.ReceiptData

/**
 * Local receipt for a completed sale. The sale is already durable in the
 * outbox; it syncs to the server (POST /v1/outbox) when connectivity
 * returns, deduped by client_operation_id.
 */
@Composable
fun ReceiptScreen(
    modifier: Modifier = Modifier,
    receipt: ReceiptData,
    onNewSale: () -> Unit,
) {
    Column(
        modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Sale recorded", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Saved on this till — will sync to the server when online",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(
                Modifier.fillMaxWidth().padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                receipt.lines.forEach { line ->
                    Text(line, style = MaterialTheme.typography.bodyLarge)
                }
                HorizontalDivider()
                Text("Total      ${receipt.total}", style = MaterialTheme.typography.titleLarge)
                Text("Tendered   ${receipt.tendered}", style = MaterialTheme.typography.bodyLarge)
                Text("Change     ${receipt.changeDue}", style = MaterialTheme.typography.bodyLarge)
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "Ref ${receipt.clientOperationId.take(8).uppercase()}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = onNewSale,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("New sale")
        }
    }
}

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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.pos.ReceiptData
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * Local receipt for a completed sale. The sale is already durable in the
 * outbox; it syncs to the server (POST /v1/outbox) when connectivity
 * returns, deduped by client_operation_id.
 *
 * Phase 5: shows the credit customer (if any) and the eReceipt status — the
 * cashier can queue the email at the till or send it manually from here once
 * the sale has synced (online path).
 */
@Composable
fun ReceiptScreen(
    modifier: Modifier = Modifier,
    receipt: ReceiptData,
    onNewSale: () -> Unit,
    onEmailReceipt: suspend (String) -> String? = { null },
) {
    val time = rememberTimestamp(receipt.timestamp)
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(receipt.emailTo.orEmpty()) }
    var emailing by remember { mutableStateOf(false) }
    var emailError by remember { mutableStateOf<String?>(null) }
    var emailSent by remember { mutableStateOf(false) }

    Column(
        modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("FlowWise", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
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
                receipt.tenders.forEach { tender ->
                    Text(tender, style = MaterialTheme.typography.bodyLarge)
                }
                Text("Change     ${receipt.changeDue}", style = MaterialTheme.typography.bodyLarge)
                receipt.customerName?.let { customer ->
                    HorizontalDivider()
                    Text(
                        "Account   $customer (credit)",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "Ref ${receipt.clientOperationId.take(8).uppercase()} · $time",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (receipt.emailTo != null) {
            Spacer(Modifier.height(12.dp))
            Text(
                if (emailSent) "Receipt sent to ${receipt.emailTo}" else "Receipt will be emailed to ${receipt.emailTo} when the sale syncs",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        } else {
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email this receipt to") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            emailError?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    scope.launch {
                        emailing = true
                        emailError = null
                        try {
                            val err = onEmailReceipt(email)
                            if (err == null) emailSent = true else emailError = err
                        } finally {
                            emailing = false
                        }
                    }
                },
                enabled = !emailing && email.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (emailing) "Sending…" else "Email receipt (needs the sale synced)")
            }
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = onNewSale,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("New sale")
        }
    }
}

@Composable
private fun rememberTimestamp(epochMillis: Long): String {
    val format = SimpleDateFormat("dd MMM yyyy, HH:mm", Locale.getDefault())
    return format.format(Date(epochMillis))
}

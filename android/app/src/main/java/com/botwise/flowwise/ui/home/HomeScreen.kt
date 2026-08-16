package com.botwise.flowwise.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.auth.AuthManager

/**
 * Post-branch-select hub. Everything in the product hangs off this screen:
 * the till (sales), stock (Phase 2 inventory ops) and procurement (Phase 3
 * reorder suggestions → POs).
 */
@Composable
fun HomeScreen(
    modifier: Modifier = Modifier,
    authManager: AuthManager,
    pendingOps: Int,
    onTill: () -> Unit,
    onRefunds: () -> Unit,
    onStock: () -> Unit,
    onProcurement: () -> Unit,
    onCustomers: () -> Unit,
    onReports: () -> Unit,
    onQueue: () -> Unit,
    onSwitchBranch: () -> Unit,
    onLogout: () -> Unit,
) {
    val meState by produceState<Pair<String, String>?>(null, authManager) {
        value = runCatching {
            val me = authManager.me()
            val org = me.optJSONObject("org")
            org.optString("name") to me.optString("name")
        }.getOrNull()
    }

    Column(modifier.fillMaxSize().padding(20.dp)) {
        val (orgName, userName) = meState ?: (null to null)
        Text(
            orgName ?: "FlowWise",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            userName ?: "Signed in",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        ModuleCard("Till", "Ring sales over the counter — works offline, syncs on reconnect", MaterialTheme.colorScheme.primary, onTill)
        ModuleCard("Refunds", "Refund a completed sale — mobile-money refunds return to the customer's wallet", MaterialTheme.colorScheme.primary, onRefunds)
        ModuleCard("Stock", "Balances, low-stock alerts, GRNs, counts, transfers, adjustments", MaterialTheme.colorScheme.secondary, onStock)
        ModuleCard("Procurement", "Reorder suggestions → purchase orders", MaterialTheme.colorScheme.tertiary, onProcurement)
        ModuleCard("Customers", "Accounts, credit sales and payments", MaterialTheme.colorScheme.tertiary, onCustomers)
        ModuleCard("Reports", "Sales summary, stock valuation, top products", MaterialTheme.colorScheme.secondary, onReports)
        ModuleCard(
            "Sync queue",
            if (pendingOps > 0) "$pendingOps operation(s) waiting — flush the offline outbox" else "Everything synced — the offline outbox is empty",
            MaterialTheme.colorScheme.onSurfaceVariant,
            onQueue,
        )

        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onSwitchBranch, modifier = Modifier.weight(1f)) {
                Text("Switch branch")
            }
            OutlinedButton(onClick = onLogout, modifier = Modifier.weight(1f)) {
                Text("Sign out")
            }
        }
    }
}

@Composable
private fun ModuleCard(title: String, subtitle: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleLarge, color = color)
                Spacer(Modifier.height(4.dp))
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("→", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

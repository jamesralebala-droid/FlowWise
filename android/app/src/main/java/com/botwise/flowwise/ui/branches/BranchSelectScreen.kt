package com.botwise.flowwise.ui.branches

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
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.botwise.flowwise.data.auth.AuthManager
import org.json.JSONObject

@Composable
fun BranchSelectScreen(authManager: AuthManager, onSelected: (branchId: String) -> Unit) {
    val meState by produceState<MeState>(MeState.Loading, authManager) {
        value = runCatching {
            // /v1/me carries profile, roles and branch scope — the basis for
            // branch selection (Phase 0 exit).
            val me = authManager.me()
            MeState.Ready(me.getJSONArray("branches"), me.optString("defaultBranch"))
        }.getOrElse { MeState.Error(it.message ?: "Failed to load branches") }
    }

    Column(Modifier.fillMaxSize().padding(24.dp)) {
        Text("Select branch", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        when (val state = meState) {
            is MeState.Loading -> Text("Loading…")
            is MeState.Error -> Text(state.message, color = MaterialTheme.colorScheme.error)
            is MeState.Ready -> LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.branches.length()) { i ->
                    val branch = state.branches.getJSONObject(i)
                    BranchCard(branch) {
                        authManager.selectedBranchId = branch.getString("id")
                        onSelected(branch.getString("id"))
                    }
                }
            }
        }
    }
}

@Composable
private fun BranchCard(branch: JSONObject, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(branch.getString("name"), style = MaterialTheme.typography.titleMedium)
                Text(
                    "Code: ${branch.optString("code")}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text("→", style = MaterialTheme.typography.titleMedium)
        }
    }
}

private sealed interface MeState {
    data object Loading : MeState
    data class Ready(val branches: org.json.JSONArray, val defaultBranch: String) : MeState
    data class Error(val message: String) : MeState
}

package com.botwise.flowwise

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.botwise.flowwise.data.outbox.OutboxWorker
import com.botwise.flowwise.data.pos.PosState
import com.botwise.flowwise.data.sync.CatalogueSyncWorker
import com.botwise.flowwise.ui.branches.BranchSelectScreen
import com.botwise.flowwise.ui.login.LoginScreen
import com.botwise.flowwise.ui.pos.PosScreen
import com.botwise.flowwise.ui.pos.ReceiptScreen
import com.botwise.flowwise.ui.scan.BarcodeScanScreen
import com.botwise.flowwise.ui.theme.FlowWiseTheme
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = (application as FlowWiseApp).container
        scheduleCatalogueSync()
        // Flush anything left in the outbox from a previous session.
        scheduleOutboxFlush(this)
        // Safety net: ops must not wait for a new sale or an app restart.
        schedulePeriodicOutboxFlush(this)

        setContent {
            FlowWiseTheme {
                AppNav(container = container)
            }
        }
    }

    private fun scheduleCatalogueSync() {
        val request = PeriodicWorkRequestBuilder<CatalogueSyncWorker>(6, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "catalogue_sync",
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }
}

/**
 * One-shot flush of the offline outbox, constrained to connectivity.
 * APPEND_OR_REPLACE: a flush enqueued while another is pending/running always
 * runs after it, so a sale completed mid-flush is still pushed — the server
 * dedupes on client_operation_id, so double-processing is harmless. A no-op
 * when nothing is pending.
 */
private fun scheduleOutboxFlush(context: Context) {
    val request = OneTimeWorkRequestBuilder<OutboxWorker>()
        .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
        )
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
        "outbox_flush",
        ExistingWorkPolicy.APPEND_OR_REPLACE,
        request,
    )
}

/**
 * Periodic safety-net flush so pending ops are pushed even when the till sits
 * idle (no new sales to trigger a one-shot). KEEP: one schedule only.
 */
private fun schedulePeriodicOutboxFlush(context: Context) {
    val request = PeriodicWorkRequestBuilder<OutboxWorker>(30, TimeUnit.MINUTES)
        .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
        )
        .build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        "outbox_flush_periodic",
        ExistingPeriodicWorkPolicy.KEEP,
        request,
    )
}

private enum class PosRoute { CART, SCAN, RECEIPT }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppNav(container: com.botwise.flowwise.di.AppContainer) {
    var loggedIn by remember { mutableStateOf(container.authManager.isLoggedIn) }
    var branchSelected by remember { mutableStateOf(container.authManager.selectedBranchId != null) }
    var route by remember { mutableStateOf(PosRoute.CART) }
    val context = LocalContext.current
    val posState = remember {
        PosState(container.apiClient, container.authManager, container.outboxDao, container.shiftStore)
    }

    val title = when {
        !loggedIn || !branchSelected -> "FlowWise"
        route == PosRoute.SCAN -> "Scan"
        route == PosRoute.RECEIPT -> "Receipt"
        else -> "FlowWise — Till"
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (loggedIn && branchSelected && route != PosRoute.CART) {
                        TextButton(onClick = { route = PosRoute.CART }) { Text("Back") }
                    }
                },
            )
        },
    ) { padding ->
        when {
            !loggedIn -> LoginScreen(container.authManager) {
                loggedIn = true
            }
            !branchSelected -> BranchSelectScreen(container.authManager) { branchId ->
                // A shift remembered for another branch must not tag this till's sales.
                if (posState.shift?.branchId != branchId) posState.clearShift()
                branchSelected = true
                route = PosRoute.CART
            }
            route == PosRoute.SCAN -> BarcodeScanScreen(
                modifier = Modifier.padding(padding),
                onResolved = { item ->
                    if (posState.addItem(item)) route = PosRoute.CART
                },
            )
            route == PosRoute.RECEIPT && posState.receipt != null -> ReceiptScreen(
                modifier = Modifier.padding(padding),
                receipt = posState.receipt!!,
                onNewSale = {
                    posState.dismissReceipt()
                    route = PosRoute.CART
                },
            )
            else -> PosScreen(
                modifier = Modifier.padding(padding),
                state = posState,
                onScan = { route = PosRoute.SCAN },
                onSaleCompleted = {
                    scheduleOutboxFlush(context)
                    route = PosRoute.RECEIPT
                },
            )
        }
    }
}

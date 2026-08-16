package com.botwise.flowwise.di

import android.content.Context
import com.botwise.flowwise.data.auth.AuthManager
import com.botwise.flowwise.data.local.AppDatabase
import com.botwise.flowwise.data.remote.ApiClient
import com.botwise.flowwise.data.shift.ShiftStore

/**
 * Manual dependency graph (no DI framework) — deliberately small in Phase 0.
 * Swap for Hilt/Koin when the module count grows.
 */
class AppContainer(context: Context) {
    val authManager = AuthManager(context)
    val apiClient = ApiClient(context)
    val shiftStore = ShiftStore(context)

    val database = AppDatabase.build(context)
    val productDao = database.productDao()
    val variantDao = database.variantDao()
    val barcodeDao = database.barcodeDao()
    val priceDao = database.priceDao()
    val branchDao = database.branchDao()
    val outboxDao = database.outboxDao()
    val syncCursorDao = database.syncCursorDao()
}

package com.botwise.flowwise.data.sync

import android.content.Context
import androidx.room.withTransaction
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.botwise.flowwise.FlowWiseApp
import com.botwise.flowwise.data.local.BarcodeEntity
import com.botwise.flowwise.data.local.PriceEntity
import com.botwise.flowwise.data.local.ProductEntity
import com.botwise.flowwise.data.local.SyncCursorEntity
import com.botwise.flowwise.data.local.VariantEntity
import org.json.JSONObject

/**
 * Phase 0 exit: a scoped device authenticates and pulls the ACTIVE branch's
 * catalogue into the encrypted local store (never the whole org dump — see
 * "known traps"). The barcode → product resolution afterwards is a purely
 * local, indexed Room lookup.
 */
class CatalogueSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as FlowWiseApp).container
        val branchId = container.authManager.selectedBranchId ?: return Result.success()
        var token = container.authManager.accessToken
        if (token == null) {
            // Access tokens live 15 minutes; rotate before giving up.
            if (container.authManager.refresh()) token = container.authManager.accessToken
            if (token == null) return Result.retry()
        }

        val catalogue = runCatching {
            container.apiClient.get("/catalogue?branchId=$branchId", token)
        }.getOrElse { return Result.retry() }

        val products = catalogue.getJSONArray("products")
        val variants = catalogue.getJSONArray("variants")
        val barcodes = catalogue.getJSONArray("barcodes")
        val prices = catalogue.getJSONArray("prices")

        container.database.withTransaction {
            val productEntities = (0 until products.length()).map { i ->
                val p = products.getJSONObject(i)
                ProductEntity(
                    id = p.getString("id"),
                    name = p.getString("name"),
                    sku = p.optString("sku").ifEmpty { null },
                    categoryId = optId(p, "categoryId"),
                    categoryName = p.optString("categoryName").ifEmpty { null },
                    uom = p.optString("uom").ifEmpty { null },
                    description = p.optString("description").ifEmpty { null },
                    isActive = true,
                    updatedAt = System.currentTimeMillis(),
                )
            }
            val variantEntities = (0 until variants.length()).map { i ->
                val v = variants.getJSONObject(i)
                VariantEntity(
                    id = v.getString("id"),
                    productId = v.getString("productId"),
                    name = v.getString("name"),
                    sku = v.optString("sku").ifEmpty { null },
                )
            }
            val barcodeEntities = (0 until barcodes.length()).map { i ->
                val b = barcodes.getJSONObject(i)
                BarcodeEntity(barcode = b.getString("barcode"), variantId = b.getString("variantId"))
            }
            val priceEntities = (0 until prices.length()).map { i ->
                val pr = prices.getJSONObject(i)
                PriceEntity(variantId = pr.getString("variantId"), price = pr.getString("price"))
            }

            container.productDao.upsertAll(productEntities)
            container.variantDao.upsertAll(variantEntities)
            container.barcodeDao.upsertAll(barcodeEntities)
            container.priceDao.upsertAll(priceEntities)
            container.syncCursorDao.upsert(
                SyncCursorEntity(cursorKey = "catalogue_$branchId", cursorValue = catalogue.optString("version", "v1")),
            )
        }
        return Result.success()
    }

    private fun optId(obj: JSONObject, key: String): String? =
        if (obj.isNull(key)) null else obj.getString(key)
}

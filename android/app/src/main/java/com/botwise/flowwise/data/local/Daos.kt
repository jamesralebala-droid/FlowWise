package com.botwise.flowwise.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(products: List<ProductEntity>)

    @Query("SELECT * FROM products WHERE id = :id")
    suspend fun byId(id: String): ProductEntity?

    @Query("SELECT COUNT(*) FROM products")
    fun count(): Flow<Int>
}

@Dao
interface VariantDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(variants: List<VariantEntity>)

    @Query("SELECT * FROM product_variants WHERE id = :id")
    suspend fun byId(id: String): VariantEntity?

    /** Catalogue picker for GRN / count / transfer / adjustment lines. */
    @Query(
        """SELECT v.id AS id, v.sku AS sku, v.name AS variantName, p.name AS productName
           FROM product_variants v JOIN products p ON p.id = v.productId
           ORDER BY p.name, v.name""",
    )
    fun picker(): Flow<List<VariantPickerRow>>
}

/** A catalogue row as shown in a line-editor picker (variant + product name). */
data class VariantPickerRow(
    val id: String,
    val sku: String?,
    val variantName: String,
    val productName: String,
)

@Dao
interface BarcodeDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(barcodes: List<BarcodeEntity>)

    /** The till hot path: indexed lookup, well under 300 ms on device. */
    @Query("SELECT * FROM barcodes WHERE barcode = :barcode LIMIT 1")
    suspend fun findByCode(barcode: String): BarcodeEntity?

    @Query("SELECT COUNT(*) FROM barcodes")
    fun count(): Flow<Int>
}

@Dao
interface PriceDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(prices: List<PriceEntity>)

    @Query("SELECT * FROM price_list_items WHERE variantId = :variantId LIMIT 1")
    suspend fun byVariant(variantId: String): PriceEntity?
}

@Dao
interface BranchDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(branches: List<BranchEntity>)

    @Query("SELECT * FROM branches WHERE isActive = 1 ORDER BY name")
    fun active(): Flow<List<BranchEntity>>

    @Query("SELECT * FROM branches WHERE id = :id")
    suspend fun byId(id: String): BranchEntity?
}

@Dao
interface OutboxDao {
    @Insert
    suspend fun insert(op: OutboxOperationEntity)

    @Query("SELECT * FROM outbox_operations WHERE status = 'pending' ORDER BY createdAt LIMIT 50")
    suspend fun pending(): List<OutboxOperationEntity>

    @Query("UPDATE outbox_operations SET status = :status, syncedAt = :syncedAt WHERE id = :id")
    suspend fun markSynced(id: Long, status: String, syncedAt: Long)

    @Query("UPDATE outbox_operations SET attempts = attempts + 1 WHERE id = :id")
    suspend fun bumpAttempts(id: Long)

    @Query("SELECT COUNT(*) FROM outbox_operations WHERE status = 'pending'")
    suspend fun pendingCount(): Int

    /** Recent operations for the Sync queue screen (newest first). */
    @Query("SELECT * FROM outbox_operations ORDER BY createdAt DESC LIMIT 100")
    suspend fun recent(): List<OutboxOperationEntity>
}

@Dao
interface SyncCursorDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(cursor: SyncCursorEntity)

    @Query("SELECT * FROM sync_cursors WHERE cursorKey = :key LIMIT 1")
    suspend fun byKey(key: String): SyncCursorEntity?
}

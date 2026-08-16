package com.botwise.flowwise.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sku: String?,
    val categoryId: String?,
    val categoryName: String?,
    val uom: String?,
    val description: String?,
    val isActive: Boolean,
    val updatedAt: Long,
)

@Entity(tableName = "product_variants", indices = [Index("productId")])
data class VariantEntity(
    @PrimaryKey val id: String,
    val productId: String,
    val name: String,
    val sku: String?,
)

@Entity(tableName = "barcodes", indices = [Index("variantId")])
data class BarcodeEntity(
    @PrimaryKey val barcode: String,
    val variantId: String,
)

@Entity(tableName = "price_list_items")
data class PriceEntity(
    @PrimaryKey val variantId: String,
    val price: String,
)

@Entity(tableName = "branches")
data class BranchEntity(
    @PrimaryKey val id: String,
    val name: String,
    val code: String,
    val isActive: Boolean,
)

/** Append-only outbox for offline writes (Phase 1 push). */
@Entity(tableName = "outbox_operations", indices = [Index(value = ["clientOperationId"], unique = true)])
data class OutboxOperationEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val clientOperationId: String,
    val opType: String,
    val payloadJson: String,
    val idempotencyKey: String,
    val status: String = "pending",
    val attempts: Int = 0,
    val createdAt: Long = System.currentTimeMillis(),
    val syncedAt: Long? = null,
)

/** Per-entity sync cursors so a reconnect resumes where it stopped. */
@Entity(tableName = "sync_cursors")
data class SyncCursorEntity(
    @PrimaryKey val cursorKey: String,
    val cursorValue: String,
    val updatedAt: Long = System.currentTimeMillis(),
)

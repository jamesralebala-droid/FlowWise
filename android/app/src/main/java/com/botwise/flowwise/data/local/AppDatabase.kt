package com.botwise.flowwise.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

@Database(
    entities = [
        ProductEntity::class,
        VariantEntity::class,
        BarcodeEntity::class,
        PriceEntity::class,
        BranchEntity::class,
        OutboxOperationEntity::class,
        SyncCursorEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun productDao(): ProductDao
    abstract fun variantDao(): VariantDao
    abstract fun barcodeDao(): BarcodeDao
    abstract fun priceDao(): PriceDao
    abstract fun branchDao(): BranchDao
    abstract fun outboxDao(): OutboxDao
    abstract fun syncCursorDao(): SyncCursorDao

    companion object {
        private const val DB_NAME = "flowwise.db"

        /**
         * SQLCipher key. In Phase 0 this is derived from the registered device
         * key material; Phase 4 hardening can wrap it with a hardware-backed
         * keystore binding. The DB is useless without the key.
         */
        private fun databaseKey(context: Context): ByteArray =
            deriveKey(context)

        fun build(context: Context): AppDatabase {
            val passphrase = databaseKey(context)
            val factory = SupportOpenHelperFactory(
                passphrase,
                net.zetetic.database.sqlcipher.SQLiteDatabaseHook { db ->
                    db.execSQL("PRAGMA cipher_migrate")
                },
                net.zetetic.database.sqlcipher.SQLiteDatabaseHook {},
            )
            return Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, DB_NAME)
                .openHelperFactory(factory)
                .build()
        }

        private fun deriveKey(context: Context): ByteArray {
            // Placeholder derivation (Phase 0): stable per-install key.
            // TODO(Phase 1): derive from the server-bound device key returned
            //  by POST /v1/devices/register, stored in encrypted prefs.
            val prefs = context.getSharedPreferences("flowwise_db_key", Context.MODE_PRIVATE)
            var key = prefs.getString("key", null)
            if (key == null) {
                key = java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID().toString()
                prefs.edit().putString("key", key).apply()
            }
            return key.toByteArray(Charsets.UTF_8)
        }
    }
}


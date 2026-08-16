# Room
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *

# ML Kit barcode scanning models
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# SQLCipher (JNI + reflection in SupportOpenHelperFactory)
-keep class net.zetetic.database.** { *; }
-dontwarn net.zetetic.**

# OkHttp / Okio (reflection + platform detection)
-dontwarn okhttp3.**
-dontwarn okio.**

# WorkManager + coroutines
-dontwarn androidx.work.**
-dontwarn kotlinx.coroutines.**

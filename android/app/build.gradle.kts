import java.io.File
import java.util.Base64
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

// ---------------------------------------------------------------------------
// Signing (Phase 8). Priority: android/keystore.properties (local dev), then
// CI env secrets (ANDROID_KEYSTORE_B64 + passwords/alias). With no keystore
// at all the release build stays UNSIGNED — side-load friendly, never a hard
// failure. keystore.properties is gitignored.
// ---------------------------------------------------------------------------
val keystoreB64 = System.getenv("ANDROID_KEYSTORE_B64")?.takeIf { it.isNotBlank() }
val keystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
val keyAlias = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val keyPassword = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
val signingProps = Properties()
rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { signingProps.load(it) }
fun propOrEnv(key: String, env: String?): String? = signingProps.getProperty(key)?.takeIf { it.isNotBlank() } ?: env

android {
    namespace = "com.botwise.flowwise"
    compileSdk = 35

    signingConfigs {
        if (keystoreB64 != null || signingProps.getProperty("storeFile") != null) {
            create("release") {
                val store = signingProps.getProperty("storeFile")?.let { rootProject.file(it) }
                    ?: File(System.getProperty("java.io.tmpdir"), "flowwise-release-keystore.jks")
                        .also { f -> f.writeBytes(Base64.getDecoder().decode(keystoreB64)) }
                storeFile = store
                storePassword = propOrEnv("storePassword", keystorePassword)
                keyAlias = propOrEnv("keyAlias", keyAlias)
                keyPassword = propOrEnv("keyPassword", keyPassword)
            }
        }
    }

    defaultConfig {
        applicationId = "com.botwise.flowwise"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // 10.0.2.2 = host loopback from the Android emulator.
        buildConfigField("String", "API_BASE_URL", "\"http://10.0.2.2:4000/v1\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: null
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.navigation.compose)

    // Local encrypted store
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.sqlcipher.android)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.datastore.preferences)

    // Sync / outbox / network
    implementation(libs.androidx.work.runtime)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)

    // Barcode scanning (ML Kit + CameraX)
    implementation(libs.mlkit.barcode)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
}

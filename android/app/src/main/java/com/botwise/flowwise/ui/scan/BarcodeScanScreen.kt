package com.botwise.flowwise.ui.scan

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.botwise.flowwise.FlowWiseApp
import com.botwise.flowwise.data.local.BarcodeEntity
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

data class ResolvedItem(
    val variantId: String,
    val name: String,
    val variant: String,
    val price: String?,
    val barcode: String,
)

@Composable
fun BarcodeScanScreen(modifier: Modifier = Modifier, onResolved: (ResolvedItem) -> Unit) {
    val context = LocalContext.current
    val container = remember { (context.applicationContext as FlowWiseApp).container }
    var resolved by remember { mutableStateOf<ResolvedItem?>(null) }
    var hasPermission by remember { mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
    ) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        hasPermission = it
    }

    DisposableEffect(Unit) {
        if (!hasPermission) launcher.launch(Manifest.permission.CAMERA)
        onDispose {}
    }

    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            if (hasPermission) {
                CameraPreview { barcodeValue ->
                    if (resolved == null) {
                        CoroutineScope(Dispatchers.IO).launch {
                            // Local, indexed lookup — the sub-300ms till path.
                            resolveLocal(container, barcodeValue)?.let { item ->
                                kotlinx.coroutines.withContext(Dispatchers.Main) {
                                    resolved = item
                                    onResolved(item)
                                }
                            }
                        }
                    }
                }
            }
        }
        Card(Modifier.fillMaxWidth().padding(16.dp)) {
            Column(Modifier.padding(16.dp)) {
                Text("Scan barcode", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                if (resolved == null) {
                    Text("Point the camera at a product barcode", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Text("${resolved!!.name} — ${resolved!!.variant}", style = MaterialTheme.typography.titleLarge)
                    resolved!!.price?.let { Text("Price: P $it", style = MaterialTheme.typography.titleMedium) }
                }
            }
        }
    }
}

private suspend fun resolveLocal(
    container: com.botwise.flowwise.di.AppContainer,
    barcode: String,
): ResolvedItem? {
    val barcodeEntity: BarcodeEntity = container.barcodeDao.findByCode(barcode) ?: return null
    val variant = container.variantDao.byId(barcodeEntity.variantId) ?: return null
    val product = container.productDao.byId(variant.productId) ?: return null
    val price = container.priceDao.byVariant(variant.id)?.price
    return ResolvedItem(variant.id, product.name, variant.name, price, barcode)
}

@Composable
private fun CameraPreview(onBarcode: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }

    DisposableEffect(lifecycleOwner) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val scanner: BarcodeScanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_CODE_128)
                .build(),
        )

        providerFuture.addListener({
            val cameraProvider = providerFuture.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(ContextCompat.getMainExecutor(context)) { imageProxy ->
                val mediaImage = imageProxy.image
                if (mediaImage != null) {
                    val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                    scanner.process(inputImage)
                        .addOnSuccessListener { barcodes ->
                            barcodes.firstOrNull()?.rawValue?.let { onBarcode(it) }
                        }
                        .addOnCompleteListener { imageProxy.close() }
                } else {
                    imageProxy.close()
                }
            }
            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
            } catch (_: Exception) {
                // camera in use; ignore for Phase 0 skeleton
            }
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            scanner.close()
        }
    }

    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
}

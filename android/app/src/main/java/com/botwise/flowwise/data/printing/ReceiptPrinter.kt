package com.botwise.flowwise.data.printing

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import com.botwise.flowwise.data.pos.ReceiptData
import java.io.OutputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Phase 6: hardware receipt printing over Bluetooth classic (SPP) — the
 * standard interface for 58mm/80mm ESC/POS thermal printers used at SME
 * tills. ESC/POS is a raw byte protocol, so no third-party library is
 * needed: we emit the command stream ourselves and write it to the socket.
 *
 * The printer is a best-effort convenience: a missing/unpaired printer never
 * blocks the sale (the receipt is already durable in the outbox and on
 * screen). Bluetooth is inherently lossy — the operator sees any error and
 * can retry.
 */

private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

// ---- ESC/POS command bytes ---------------------------------------------------
private const val ESC = 0x1B.toByte()
private const val GS = 0x1D.toByte()
private const val LF = 0x0A.toByte()

private fun ByteArray.esc(vararg bytes: Int): ByteArray {
    val out = ByteArray(size + bytes.size)
    System.arraycopy(this, 0, out, 0, size)
    bytes.forEachIndexed { i, b -> out[size + i] = b.toByte() }
    return out
}

private fun ByteArray.text(s: String): ByteArray {
    val sanitised = s
        .replace('−', '-')
        .replace('—', '-')
        .replace('·', '.')
        .replace('≈', '~')
        .replace('…', "...")
        .replace('▾', '>')
    val bytes = sanitised.toByteArray(Charsets.ISO_8859_1)
    val out = ByteArray(size + bytes.size + 1)
    System.arraycopy(this, 0, out, 0, size)
    System.arraycopy(bytes, 0, out, size, bytes.size)
    out[size + bytes.size] = LF
    return out
}

/** Builds a complete ESC/POS receipt document (init → header → lines → cut). */
fun buildEscPosReceipt(
    receipt: ReceiptData,
    orgName: String = "FlowWise",
    branchName: String = "",
): ByteArray {
    var out = byteArrayOf(ESC, 0x40.toByte()) // initialize
    out = out.esc(0x1B, 0x61, 0x01) // center
    out = out.esc(0x1B, 0x21, 0x30) // double width + height
    out = out.esc(0x1B, 0x45, 0x01) // bold
    out = out.text(orgName)
    if (branchName.isNotBlank()) {
        out = out.esc(0x1B, 0x21, 0x00) // normal size
        out = out.text(branchName)
    }
    out = out.esc(0x1B, 0x45, 0x00) // bold off
    out = out.text("Ref ${receipt.clientOperationId.take(8).uppercase()}")
    out = out.text(java.text.SimpleDateFormat("dd MMM yyyy, HH:mm", java.util.Locale.getDefault())
        .format(java.util.Date(receipt.timestamp)))
    out = out.esc(0x1B, 0x61, 0x00) // left
    out = out.text("")
    for (line in receipt.lines) out = out.text(line)
    out = out.text("")
    out = out.esc(0x1B, 0x45, 0x01)
    out = out.text("TOTAL  ${receipt.total}")
    out = out.esc(0x1B, 0x45, 0x00)
    for (tender in receipt.tenders) out = out.text(tender)
    out = out.text("Change  ${receipt.changeDue}")
    receipt.customerName?.let { out = out.text("Account  $it") }
    out = out.text("")
    out = out.esc(0x1B, 0x61, 0x01)
    out = out.text("Thank you for shopping with us.")
    out = out.esc(0x1B, 0x61, 0x00)
    out = out.esc(0x1B, 0x64, 0x03) // feed 3 lines
    out = out.esc(GS.toInt(), 0x56, 0x00) // cut (partial)
    return out
}

/** Bluetooth classic (SPP) transport for ESC/POS printers. */
class ReceiptPrinter {
    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()

    /** Bonded devices — the operator pairs the printer in Android settings. */
    fun bondedPrinters(): List<BluetoothDevice> =
        adapter?.bondedDevices?.filter { it.type != BluetoothDevice.DEVICE_TYPE_LE }.orEmpty().sortedBy { it.name }

    suspend fun print(device: BluetoothDevice, bytes: ByteArray): Unit = withContext(Dispatchers.IO) {
        val socket: BluetoothSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
        try {
            socket.connect()
            val out: OutputStream = socket.outputStream
            out.write(bytes)
            out.flush()
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }
}

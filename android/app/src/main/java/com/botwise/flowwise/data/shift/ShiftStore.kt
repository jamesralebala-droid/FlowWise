package com.botwise.flowwise.data.shift

import android.content.Context

/** The locally-known open shift for the selected branch (server is authoritative). */
data class ShiftInfo(
    val id: String,
    val branchId: String,
    val openedAt: Long,
)

/**
 * Plain SharedPreferences holder for the open till shift. The shift itself is
 * a server record (created via POST /v1/shifts); this only remembers its id
 * so subsequent sales carry shiftId and the cash-up can close it.
 */
class ShiftStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("flowwise_shift", Context.MODE_PRIVATE)

    var current: ShiftInfo?
        get() {
            val id = prefs.getString("shift_id", null) ?: return null
            val branchId = prefs.getString("shift_branch_id", null) ?: return null
            return ShiftInfo(id, branchId, prefs.getLong("shift_opened_at", 0L))
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    remove("shift_id")
                    remove("shift_branch_id")
                    remove("shift_opened_at")
                } else {
                    putString("shift_id", value.id)
                    putString("shift_branch_id", value.branchId)
                    putLong("shift_opened_at", value.openedAt)
                }
            }.apply()
        }
}

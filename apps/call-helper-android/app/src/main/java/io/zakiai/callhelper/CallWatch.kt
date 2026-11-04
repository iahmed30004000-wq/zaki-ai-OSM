package io.zakiai.callhelper

import android.Manifest
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CallLog
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import java.util.concurrent.Executor

/** Watches the phone's call state while the app's own call is in progress. */
interface CallWatcher {
    fun stop()
}

object CallWatch {
    /**
     * Start watching; [onState] receives TelephonyManager.CALL_STATE_* on the
     * main thread. Null when READ_PHONE_STATE is not granted.
     */
    fun start(c: Context, onState: (Int) -> Unit): CallWatcher? {
        if (c.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return null
        val tm = c.getSystemService(TelephonyManager::class.java) ?: return null
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Modern(tm, c.mainExecutor, onState)
            } else {
                Legacy(tm, onState)
            }
        } catch (e: SecurityException) {
            null
        }
    }

    /** Android 12 and later. READ_PHONE_STATE is checked in [start] before this is built. */
    @TargetApi(Build.VERSION_CODES.S)
    @SuppressLint("MissingPermission")
    private class Modern(
        private val tm: TelephonyManager,
        executor: Executor,
        private val onState: (Int) -> Unit,
    ) : CallWatcher {
        private val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
            override fun onCallStateChanged(state: Int) = onState(state)
        }

        init {
            tm.registerTelephonyCallback(executor, callback)
        }

        override fun stop() = tm.unregisterTelephonyCallback(callback)
    }

    /** Android 8 to 11. */
    @Suppress("DEPRECATION")
    private class Legacy(
        private val tm: TelephonyManager,
        private val onState: (Int) -> Unit,
    ) : CallWatcher {
        // The second argument (a number) is ignored: only the state is read.
        private val listener = object : PhoneStateListener() {
            @Deprecated("Deprecated in Java")
            override fun onCallStateChanged(state: Int, phoneNumber: String?) = onState(state)
        }

        init {
            tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
        }

        override fun stop() = tm.listen(listener, PhoneStateListener.LISTEN_NONE)
    }
}

/** The one row of the call log that is the call the app placed. */
class LoggedCall(val date: Long, val durationSeconds: Long)

object CallLogReader {
    /**
     * The outgoing call to [phone] placed since [startedAt] (less five seconds
     * of clock slack), newest first, or null.
     *
     * Only OUTGOING rows inside that window are asked for, and of those only
     * the one whose last eight digits are the number dialled is returned; the
     * rest are compared in memory and dropped. Nothing else in the log is read.
     */
    fun find(c: Context, phone: String, startedAt: Long): LoggedCall? {
        if (c.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return null
        val projection = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION)
        val selection = "${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls.DATE} >= ?"
        val args = arrayOf(CallLog.Calls.OUTGOING_TYPE.toString(), (startedAt - 5_000).toString())
        return try {
            c.contentResolver.query(
                CallLog.Calls.CONTENT_URI, projection, selection, args, "${CallLog.Calls.DATE} DESC",
            )?.use { cur ->
                var found: LoggedCall? = null
                while (found == null && cur.moveToNext()) {
                    val number = cur.getString(0) ?: continue
                    if (Reading.sameNumber(number, phone)) found = LoggedCall(cur.getLong(1), cur.getLong(2))
                }
                found
            }
        } catch (e: SecurityException) {
            null
        }
    }
}

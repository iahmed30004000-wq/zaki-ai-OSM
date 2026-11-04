package io.zakiai.callhelper

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * `zakicall://call?order=<orderId>&phone=<digits, international, no +>`
 *
 * Places the call, watches it end, reads THAT call from the log, tells the
 * server, and steps back so she lands in Chrome on the same tab.
 *
 *   not paired / a permission missing → says why, offers the fix, and
 *   «اتصل بدون المساعد» (the dialler with the number typed in, nothing read).
 */
class CallActivity : Activity() {
    private lateinit var column: LinearLayout
    private lateinit var line: TextView
    private val main = Handler(Looper.getMainLooper())

    private var orderId = ""
    private var phone = ""
    private var startedAt = 0L
    private var placed = false
    private var seenOffhook = false
    private var resolving = false
    private var resumed = false
    private var showingProblem = false
    private var lastState = TelephonyManager.CALL_STATE_IDLE
    private var watcher: CallWatcher? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        live = true
        column = Ui.page(this)
        line = Ui.text(this, "", 17f, bold = true)
        Outbox.flush(this, callActive = false)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (placed) {
            // A second link while her call is still on: the call in progress is the one we report.
            Toast.makeText(this, R.string.call_busy, Toast.LENGTH_SHORT).show()
            return
        }
        setIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        watcher?.stop()
        watcher = null
        main.removeCallbacksAndMessages(null)
        live = false
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        resumed = false
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (showingProblem && !placed) {
            // Back from Settings with the permissions granted: carry on with the call she asked for.
            if (Store.pairing(this) != null && Perms.missing(this).isEmpty()) handle(intent)
            return
        }
        if (!placed || resolving) return
        /*
         * THE FALLBACK FOR A CALL THAT NEVER WENT OFF-HOOK.
         *
         * The state listener ends the watch on OFFHOOK → IDLE. When the dialler
         * comes back without the line ever going off-hook (the SIM chooser was
         * cancelled, there is no signal), only her return here says it is over.
         * Wait a moment first: a dual-SIM chooser closing also resumes us just
         * before the call itself starts.
         */
        main.postDelayed({
            if (resumed && placed && !resolving && lastState == TelephonyManager.CALL_STATE_IDLE) callEnded()
        }, 2_500)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMS) handle(intent)
    }

    private fun handle(intent: Intent?) {
        column.removeAllViews()
        showingProblem = false
        line.text = ""
        column.addView(line)
        val data = intent?.data
        val order = data?.getQueryParameter("order")
        val number = data?.getQueryParameter("phone")
        if (!Links.isOrderId(order) || !Links.isPhone(number)) {
            line.text = getString(R.string.call_bad_link)
            line.setTextColor(getColor(R.color.bad))
            column.addView(Ui.button(this, getString(R.string.close)) { finish() })
            return
        }
        orderId = order!!
        phone = number!!

        if (Store.pairing(this) == null) {
            problem(getString(R.string.call_need_pair), getString(R.string.call_fix_pair)) {
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
            return
        }
        val missing = Perms.missing(this)
        if (missing.isNotEmpty()) {
            val names = missing.joinToString(getString(R.string.list_separator)) { getString(it.label) }
            problem(getString(R.string.call_need_perms, names), getString(R.string.call_fix_perms)) {
                Perms.ask(this, missing, REQ_PERMS)
            }
            return
        }
        place()
    }

    /** Why the helper cannot call, the button that fixes it, and the plain dialler. */
    private fun problem(why: String, fixLabel: String, fix: () -> Unit) {
        showingProblem = true
        line.text = why
        line.setTextColor(getColor(R.color.bad))
        column.addView(Ui.button(this, fixLabel, fix))
        column.addView(Ui.button(this, getString(R.string.dial_without)) {
            try {
                startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", "+$phone", null)))
            } catch (e: Exception) {
                Toast.makeText(this, R.string.call_failed, Toast.LENGTH_LONG).show()
            }
            finish()
        })
    }

    @SuppressLint("MissingPermission")
    private fun place() {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            handle(intent)
            return
        }
        line.setTextColor(getColor(R.color.brand))
        line.text = getString(R.string.calling, Reading.arabicDigits("+$phone"))
        seenOffhook = false
        resolving = false
        lastState = TelephonyManager.CALL_STATE_IDLE
        watcher?.stop()
        watcher = CallWatch.start(this) { state -> onCallState(state) }

        startedAt = System.currentTimeMillis()
        Store.savePending(this, Pending(orderId, phone, startedAt, 0))
        placed = true
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", "+$phone", null)))
        } catch (e: Exception) {
            placed = false
            watcher?.stop()
            watcher = null
            Store.clearPending(this)
            line.text = getString(R.string.call_failed)
            line.setTextColor(getColor(R.color.bad))
            column.addView(Ui.button(this, getString(R.string.close)) { finish() })
        }
    }

    private fun onCallState(state: Int) {
        lastState = state
        if (!placed || resolving) return
        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> seenOffhook = true
            TelephonyManager.CALL_STATE_IDLE -> if (seenOffhook) callEnded()
        }
    }

    /** The call is over: read it from the log (it is written a moment later), report, step back. */
    private fun callEnded() {
        if (resolving) return
        resolving = true
        watcher?.stop()
        watcher = null
        val endedAt = System.currentTimeMillis()
        val order = orderId
        val number = phone
        val started = startedAt
        Store.savePending(this, Pending(order, number, started, endedAt))
        line.text = getString(R.string.reading_log)
        val app = applicationContext

        Thread {
            var logged: LoggedCall? = null
            for (wait in longArrayOf(1_500, 1_500, 2_000)) {
                try {
                    Thread.sleep(wait)
                } catch (e: InterruptedException) {
                    break
                }
                logged = CallLogReader.find(app, number, started)
                if (logged != null) break
            }
            Store.clearPending(app, started)

            val message: String
            var longToast = false
            if (logged == null) {
                message = app.getString(R.string.not_found)
                longToast = true
            } else {
                val talk = logged.durationSeconds
                val answered = talk > 0
                val ring = Reading.ringSeconds(started, endedAt, talk)
                val body = Outbox.readingBody(order, number, started, answered, talk, ring)
                val result = Outbox.send(app, order, started, body)
                val head = if (answered) {
                    app.getString(R.string.answered_line, Reading.clock(talk))
                } else {
                    app.getString(R.string.not_answered_line, Reading.arabicDigits(ring.toString()))
                }
                message = when (result) {
                    Sent.SENT -> head
                    Sent.QUEUED -> "$head ${app.getString(R.string.queued_suffix)}"
                    Sent.REVOKED, Sent.UNPAIRED -> {
                        longToast = true
                        "$head — ${app.getString(R.string.token_revoked)}"
                    }
                }
            }
            main.post {
                Toast.makeText(app, message, if (longToast) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
                placed = false
                stepBack()
            }
        }.start()
    }

    /** Back to the page she called from (Chrome, same tab), leaving nothing in Recents. */
    private fun stepBack() {
        if (isFinishing || isDestroyed) return
        moveTaskToBack(true)
        finishAndRemoveTask()
    }

    companion object {
        private const val REQ_PERMS = 21

        /** True while a CallActivity exists in this process (it owns the call in flight). */
        @Volatile
        var live = false
    }
}

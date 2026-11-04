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
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * `zakicall://call?order=<orderId>&phone=<digits, international, no +>&exp=…&sig=…`
 *
 * Places the call, watches it end, reads THAT call from the log, tells the
 * server, and steps back so she lands in Chrome on the same tab.
 *
 *   dials by itself ONLY when the link carries `exp` + `sig` signed with the
 *   pairing's call key, is not expired, has never been dialled before (a sig
 *   is single-use: SigLedger), and arrived as a fresh link — never when the
 *   activity is re-created (rotation, night mode, a process restored by the
 *   system). Any other link shows «اتصال بـ +…؟» with the number big, and
 *   dials only on «اتصل».
 *
 *   not paired / a permission missing → says why, offers the fix, and
 *   «اتصل بدون المساعد» (the dialler with the number typed in, nothing read).
 *
 *   re-created DURING a call → it picks the same call up again (the one in
 *   Store.pending) instead of placing a new one.
 */
class CallActivity : Activity() {
    private lateinit var column: LinearLayout
    private lateinit var line: TextView
    private lateinit var title: TextView
    private lateinit var number: TextView
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

    /** False once this instance is a re-creation: a link it re-reads is never dialled by itself. */
    private var autoAllowed = true

    /** Re-created mid-call: the end is only known when this instance saw the line go off-hook. */
    private var restored = false
    private var sawOffhookHere = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        live = true
        column = Ui.page(this)
        line = Ui.text(this, "", 17f, bold = true)
        title = Ui.text(this, "", 20f, bold = true)
        number = Ui.text(this, "", 32f, R.color.brand, bold = true).apply {
            // A phone number reads left to right, whatever the page around it does.
            layoutDirection = View.LAYOUT_DIRECTION_LTR
            textDirection = View.TEXT_DIRECTION_LTR
            textAlignment = View.TEXT_ALIGNMENT_CENTER
            gravity = Gravity.CENTER
        }

        if (savedInstanceState == null) {
            Outbox.flush(this, callActive = false)
            handle(intent)
            return
        }

        autoAllowed = false
        val wasPlaced = savedInstanceState.getBoolean(S_PLACED)
        val savedStart = savedInstanceState.getLong(S_STARTED)
        val pending = Store.pending(this)
        when {
            // The reading of the call was already under way in the instance that was destroyed;
            // its thread finishes it (or Store.pending makes it an orphan for the next open).
            wasPlaced && savedInstanceState.getBoolean(S_RESOLVING) -> {
                Outbox.flush(this, callActive = false)
                stepBack()
            }
            // The call is still ours: watch it again rather than dial again.
            wasPlaced && pending != null && pending.startedAt == savedStart -> {
                Outbox.flush(this, callActive = true)
                resume(pending, savedInstanceState.getBoolean(S_OFFHOOK))
            }
            // Placed, but the call is no longer on Store.pending: it has been reported already.
            wasPlaced -> {
                Outbox.flush(this, callActive = false)
                stepBack()
            }
            else -> {
                Outbox.flush(this, callActive = false)
                handle(intent)
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(S_PLACED, placed)
        outState.putLong(S_STARTED, startedAt)
        outState.putBoolean(S_OFFHOOK, seenOffhook)
        outState.putBoolean(S_RESOLVING, resolving)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (placed) {
            // A second link while her call is still on: the call in progress is the one we report.
            Toast.makeText(this, R.string.call_busy, Toast.LENGTH_SHORT).show()
            return
        }
        setIntent(intent)
        autoAllowed = true // a fresh link, opened by her just now
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
        val rawPhone = data?.getQueryParameter("phone")
        if (!Links.isOrderId(order) || !Links.isPhone(rawPhone)) {
            line.text = getString(R.string.call_bad_link)
            line.setTextColor(getColor(R.color.bad))
            column.addView(Ui.button(this, getString(R.string.close)) { finish() })
            return
        }
        orderId = order!!
        phone = rawPhone!!
        line.setTextColor(getColor(R.color.bad))
        showNumber()

        val pairing = Store.pairing(this)
        if (pairing == null) {
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
        val exp = data?.getQueryParameter("exp")
        val sig = data?.getQueryParameter("sig")
        val signed = autoAllowed &&
            CallSig.verify(pairing.callKey, orderId, phone, exp, sig, System.currentTimeMillis() / 1000) &&
            !Store.sigUsed(this, sig!!)
        if (signed) {
            // Spent before the call is placed, so no re-read of this link can dial it again.
            Store.markSigUsed(this, sig!!, exp!!.toLong(), System.currentTimeMillis() / 1000)
            place()
        } else {
            confirm()
        }
    }

    /** The number she is about to call, big and left to right, under «اتصال بـ +…؟». */
    private fun showNumber() {
        number.text = "+$phone"
        title.text = getString(R.string.confirm_title, "⁦+$phone⁩")
        column.addView(title, 0)
        column.addView(number, 1)
    }

    /** A link the site did not sign (or that expired, or was used): ask, never dial by itself. */
    private fun confirm() {
        line.text = getString(R.string.confirm_why)
        line.setTextColor(getColor(R.color.muted))
        column.addView(Ui.button(this, getString(R.string.confirm_call)) { place() })
        column.addView(Ui.button(this, getString(R.string.confirm_no)) { finish() })
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
        column.addView(Ui.button(this, getString(R.string.confirm_no)) { finish() })
    }

    /** Only the number and the line stay: no button is left to press during the call. */
    private fun showCalling() {
        column.removeAllViews()
        if (title.text.isEmpty()) title.text = getString(R.string.confirm_title, "⁦+$phone⁩")
        number.text = "+$phone"
        column.addView(title)
        column.addView(number)
        column.addView(line)
        line.setTextColor(getColor(R.color.brand))
        line.text = getString(R.string.calling, Reading.arabicDigits("+$phone"))
    }

    @SuppressLint("MissingPermission")
    private fun place() {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            handle(intent)
            return
        }
        if (placed) return // «اتصل» pressed twice
        showCalling()
        seenOffhook = false
        sawOffhookHere = false
        restored = false
        resolving = false
        lastState = TelephonyManager.CALL_STATE_IDLE
        watcher?.stop()
        watcher = CallWatch.start(this) { state -> onCallState(state) }

        // A call left over from an earlier run becomes a queued reading BEFORE this one
        // takes its place — under the same lock the background flush uses.
        startedAt = Outbox.replacePending(this, orderId, phone)
        placed = true
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", "+$phone", null)))
        } catch (e: Exception) {
            placed = false
            watcher?.stop()
            watcher = null
            Store.clearPending(this, startedAt)
            line.text = getString(R.string.call_failed)
            line.setTextColor(getColor(R.color.bad))
            column.addView(Ui.button(this, getString(R.string.close)) { finish() })
        }
    }

    /** Re-created while her call was on: watch the same call again. */
    private fun resume(pending: Pending, offhookBefore: Boolean) {
        orderId = pending.orderId
        phone = pending.phone
        startedAt = pending.startedAt
        showCalling()
        placed = true
        restored = true
        seenOffhook = offhookBefore
        sawOffhookHere = false
        resolving = false
        lastState = TelephonyManager.CALL_STATE_IDLE
        watcher = CallWatch.start(this) { state -> onCallState(state) }
        // Without READ_PHONE_STATE nothing will ever say it ended: read what the log has.
        if (watcher == null) callEnded()
    }

    private fun onCallState(state: Int) {
        lastState = state
        if (!placed || resolving) return
        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                seenOffhook = true
                sawOffhookHere = true
            }
            TelephonyManager.CALL_STATE_IDLE -> if (seenOffhook) callEnded()
        }
    }

    /** The call is over: read it from the log (it is written a moment later), report, step back. */
    private fun callEnded() {
        if (resolving) return
        resolving = true
        watcher?.stop()
        watcher = null
        // A re-created instance that never saw the line go off-hook did not see the end either.
        val endUnknown = restored && !sawOffhookHere
        val endedAt = if (endUnknown) 0L else System.currentTimeMillis()
        val order = orderId
        val number = phone
        val started = startedAt
        Store.updatePendingEnd(this, started, endedAt)
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
            // Only the one who takes the call off Store.pending reports it: never twice.
            val ours = Store.clearPending(app, started)

            val message: String
            var longToast = false
            if (logged == null) {
                message = app.getString(R.string.not_found)
                longToast = true
            } else {
                val talk = logged.durationSeconds
                val answered = talk > 0
                val ring = if (endedAt > 0) Reading.ringSeconds(started, endedAt, talk) else 0L
                val head = if (answered) {
                    app.getString(R.string.answered_line, Reading.clock(talk))
                } else {
                    app.getString(R.string.not_answered_line, Reading.arabicDigits(ring.toString()))
                }
                if (!ours) {
                    message = head
                } else {
                    val body = Outbox.readingBody(order, number, started, answered, talk, ring)
                    message = when (Outbox.send(app, order, started, body)) {
                        Sent.SENT -> head
                        Sent.QUEUED -> "$head ${app.getString(R.string.queued_suffix)}"
                        Sent.REVOKED, Sent.UNPAIRED -> {
                            longToast = true
                            "$head — ${app.getString(R.string.token_revoked)}"
                        }
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
        private const val S_PLACED = "placed"
        private const val S_STARTED = "startedAt"
        private const val S_OFFHOOK = "seenOffhook"
        private const val S_RESOLVING = "resolving"

        /** True while a CallActivity exists in this process (it owns the call in flight). */
        @Volatile
        var live = false
    }
}

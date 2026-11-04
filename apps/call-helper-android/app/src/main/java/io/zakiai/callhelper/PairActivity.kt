package io.zakiai.callhelper

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * `zakicall://pair?base=<https origin>&code=<one-time code>`
 *
 * Any page can open this link, so nothing happens until she has read the
 * host and pressed «اربط». Then the one-time code is exchanged for a token,
 * which replaces any earlier pairing.
 */
class PairActivity : Activity() {
    private lateinit var column: LinearLayout
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        column = Ui.page(this)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        column.removeAllViews()
        val data = intent?.data
        val rawBase = data?.getQueryParameter("base")
        val code = data?.getQueryParameter("code")
        val base = Links.origin(rawBase, BuildConfig.DEBUG)
        if (base == null || !Links.isPairCode(code)) {
            val plainHttp = base == null && rawBase?.trim()?.lowercase()?.startsWith("http://") == true
            val why = if (plainHttp) {
                R.string.pair_not_https
            } else {
                R.string.pair_bad_link
            }
            column.addView(Ui.text(this, getString(why), 17f, R.color.bad, bold = true))
            column.addView(Ui.button(this, getString(R.string.close)) { finish() })
            return
        }

        column.addView(Ui.text(this, getString(R.string.pair_question, Links.host(base)), 20f, bold = true))
        val line = Ui.text(this, "", 15f, R.color.muted)
        val pair = Ui.button(this, getString(R.string.pair_button)) {}
        val cancel = Ui.button(this, getString(R.string.cancel)) { finish() }
        pair.setOnClickListener { pair(base, code!!, line, pair, cancel) }
        column.addView(pair)
        column.addView(cancel)
        column.addView(line)
    }

    private fun pair(base: String, code: String, line: TextView, pair: Button, cancel: Button) {
        pair.isEnabled = false
        cancel.isEnabled = false
        line.text = getString(R.string.pairing)
        val body = JSONObject()
            .put("code", code)
            .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
        Thread {
            val reply = Api.post("$base/api/call-helper/pair", body, null)
            main.post {
                if (isFinishing || isDestroyed) return@post
                pair.isEnabled = true
                cancel.isEnabled = true
                when (reply) {
                    is Reply.Ok -> {
                        val token = reply.json.optString("token")
                        if (token.isBlank()) {
                            line.text = getString(R.string.pair_bad_reply)
                            return@post
                        }
                        val userName = reply.json.optString("userName")
                        // No key, or one of the wrong shape: kept empty, so every call link asks first.
                        val callKey = reply.json.optString("callKey").takeIf { CallSig.isCallKey(it) } ?: ""
                        Store.savePairing(this, base, token, userName, callKey)
                        Toast.makeText(this, getString(R.string.paired_ok, userName.ifBlank { Links.host(base) }), Toast.LENGTH_LONG).show()
                        startActivity(Intent(this, MainActivity::class.java))
                        finish()
                    }
                    is Reply.Refused -> {
                        line.text = reply.error ?: if (reply.code == 404) {
                            getString(R.string.pair_no_route)
                        } else {
                            getString(R.string.pair_refused, Reading.arabicDigits(reply.code.toString()))
                        }
                    }
                    Reply.Failed -> {
                        line.text = getString(R.string.net_error)
                    }
                }
            }
        }.start()
    }
}

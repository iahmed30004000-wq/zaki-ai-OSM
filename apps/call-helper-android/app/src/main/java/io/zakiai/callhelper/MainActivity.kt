package io.zakiai.callhelper

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.Toast

/**
 * THE LAUNCHER SCREEN: is this phone paired, are the three permissions
 * granted, «افصل», and the version. Opening it also sends what is waiting.
 */
class MainActivity : Activity() {
    private lateinit var column: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        column = Ui.page(this)
        Outbox.flush(this, CallActivity.live)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    private fun render() {
        column.removeAllViews()
        column.addView(Ui.text(this, getString(R.string.main_title), 22f, R.color.brand, bold = true))
        column.addView(Ui.text(this, getString(R.string.main_intro), 14f, R.color.muted))
        column.addView(Ui.gap(this))

        val pairing = Store.pairing(this)
        if (pairing != null) {
            column.addView(Ui.text(this, getString(R.string.status_paired, Links.host(pairing.base)), 17f, R.color.ok, bold = true))
            if (pairing.userName.isNotBlank()) {
                column.addView(Ui.text(this, getString(R.string.status_paired_user, pairing.userName), 15f))
            }
        } else {
            column.addView(Ui.text(this, getString(R.string.status_unpaired), 17f, R.color.bad, bold = true))
        }

        column.addView(Ui.gap(this))
        column.addView(Ui.text(this, getString(R.string.perms_title), 18f, bold = true))
        for (p in Perms.ALL) {
            val ok = Perms.granted(this, p)
            val state = getString(if (ok) R.string.perm_granted else R.string.perm_missing)
            column.addView(Ui.text(this, "${getString(p.label)} — $state", 16f, if (ok) R.color.ok else R.color.bad, bold = true))
            column.addView(Ui.text(this, getString(p.why), 14f, R.color.muted))
            if (!ok) column.addView(Ui.button(this, getString(R.string.grant)) { Perms.ask(this, listOf(p), REQ_ONE) })
        }
        if (Perms.missing(this).isNotEmpty()) {
            column.addView(Ui.text(this, getString(R.string.restricted_hint), 13f, R.color.muted))
            column.addView(Ui.button(this, getString(R.string.open_settings)) { Perms.openSettings(this) })
        }

        val waiting = Store.queued(this).size
        if (waiting > 0) {
            column.addView(Ui.gap(this))
            column.addView(Ui.text(this, getString(R.string.queue_count, Reading.arabicDigits(waiting.toString())), 14f, R.color.muted))
        }

        if (pairing != null) {
            column.addView(Ui.gap(this))
            column.addView(Ui.button(this, getString(R.string.disconnect)) { confirmDisconnect() })
        }

        column.addView(Ui.gap(this, 24))
        column.addView(Ui.text(this, getString(R.string.version, BuildConfig.VERSION_NAME), 12f, R.color.muted))
    }

    private fun confirmDisconnect() {
        AlertDialog.Builder(this)
            .setMessage(R.string.disconnect_question)
            .setPositiveButton(R.string.disconnect) { _, _ ->
                Store.clearPairing(this)
                Toast.makeText(this, R.string.disconnected, Toast.LENGTH_SHORT).show()
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private companion object {
        const val REQ_ONE = 11
    }
}

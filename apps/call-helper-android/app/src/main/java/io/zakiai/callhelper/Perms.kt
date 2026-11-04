package io.zakiai.callhelper

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings

/** One of the three permissions she grants, with what it is for. */
class Perm(val name: String, val label: Int, val why: Int)

object Perms {
    val ALL = listOf(
        Perm(Manifest.permission.CALL_PHONE, R.string.perm_call, R.string.perm_call_why),
        Perm(Manifest.permission.READ_PHONE_STATE, R.string.perm_state, R.string.perm_state_why),
        Perm(Manifest.permission.READ_CALL_LOG, R.string.perm_log, R.string.perm_log_why),
    )

    fun granted(c: Context, p: Perm): Boolean =
        c.checkSelfPermission(p.name) == PackageManager.PERMISSION_GRANTED

    fun missing(c: Context): List<Perm> = ALL.filter { !granted(c, it) }

    /**
     * Ask for [perms]. One she has already refused for good can only be
     * granted from the app's page in Settings, so that page is opened instead.
     */
    fun ask(a: Activity, perms: List<Perm>, requestCode: Int) {
        if (perms.isEmpty()) return
        val onlySettings = perms.any { Store.wasAsked(a, it.name) && !a.shouldShowRequestPermissionRationale(it.name) }
        if (onlySettings) {
            openSettings(a)
            return
        }
        perms.forEach { Store.markAsked(a, it.name) }
        a.requestPermissions(perms.map { it.name }.toTypedArray(), requestCode)
    }

    fun openSettings(a: Activity) {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", a.packageName, null))
        a.startActivity(i)
    }
}

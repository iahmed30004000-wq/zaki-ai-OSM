package io.zakiai.callhelper

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The phone's pairing with one account. [callKey] signs the call links the
 * site sends (contract v1.1); empty when the site gave none, and then every
 * call link is asked about before it dials.
 */
class Pairing(val base: String, val token: String, val userName: String, val callKey: String)

/** The call the app placed and has not reported yet. [endedAt] is 0 until the end was seen. */
class Pending(val orderId: String, val phone: String, val startedAt: Long, val endedAt: Long)

/**
 * EVERYTHING THE APP KEEPS, IN ONE PRIVATE FILE.
 *
 * MODE_PRIVATE shared preferences: no other app can read them, backup and
 * device-to-device transfer are switched off in the manifest, and the file
 * holds the pairing (with its call key), the readings waiting to be sent, and the one call in
 * flight — nothing else. No call that the app did not place is ever kept.
 *
 * (EncryptedSharedPreferences was left out on purpose: it is a deprecated
 * AndroidX library that would be this app's only dependency, and a private
 * file on a phone that is not rooted is already out of every other app's reach.)
 *
 * The queue and the call in flight belong to the pairing: a new pairing,
 * «افصل», or a revoked token clears them with it, so one account's readings
 * are never sent under another account's token.
 */
object Store {
    private const val FILE = "call_helper"
    private const val ASKED_FILE = "asked_permissions"
    private const val K_BASE = "base"
    private const val K_TOKEN = "token"
    private const val K_USER = "user_name"
    private const val K_CALL_KEY = "call_key"
    private const val K_QUEUE = "queue"
    private const val K_PENDING = "pending"

    private fun prefs(c: Context): SharedPreferences =
        c.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private fun asked(c: Context): SharedPreferences =
        c.applicationContext.getSharedPreferences(ASKED_FILE, Context.MODE_PRIVATE)

    // ── the pairing ──

    @Synchronized
    fun pairing(c: Context): Pairing? {
        val p = prefs(c)
        val base = p.getString(K_BASE, null) ?: return null
        val token = p.getString(K_TOKEN, null) ?: return null
        return Pairing(base, token, p.getString(K_USER, "") ?: "", p.getString(K_CALL_KEY, "") ?: "")
    }

    /** A new pairing replaces the old one, and everything that belonged to it. */
    @Synchronized
    fun savePairing(c: Context, base: String, token: String, userName: String, callKey: String) {
        prefs(c).edit().clear()
            .putString(K_BASE, base)
            .putString(K_TOKEN, token)
            .putString(K_USER, userName)
            .putString(K_CALL_KEY, callKey)
            .commit()
    }

    @Synchronized
    fun clearPairing(c: Context) {
        prefs(c).edit().clear().commit()
    }

    // ── the readings waiting to be sent ──

    @Synchronized
    fun queued(c: Context): List<Queued> = QueueRules.prune(readQueue(c), System.currentTimeMillis())

    @Synchronized
    fun enqueue(c: Context, id: String, body: JSONObject) {
        val now = System.currentTimeMillis()
        writeQueue(c, QueueRules.prune(readQueue(c) + Queued(id, now, body.toString()), now))
    }

    @Synchronized
    fun dequeue(c: Context, id: String) {
        writeQueue(c, readQueue(c).filter { it.id != id })
    }

    private fun readQueue(c: Context): List<Queued> {
        val raw = prefs(c).getString(K_QUEUE, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val body = o.optString("body").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                Queued(id, o.optLong("at"), body)
            }
        } catch (e: JSONException) {
            emptyList()
        }
    }

    private fun writeQueue(c: Context, items: List<Queued>) {
        val arr = JSONArray()
        for (q in items) arr.put(JSONObject().put("id", q.id).put("at", q.at).put("body", q.body))
        prefs(c).edit().putString(K_QUEUE, arr.toString()).commit()
    }

    // ── the one call in flight ──

    @Synchronized
    fun pending(c: Context): Pending? {
        val raw = prefs(c).getString(K_PENDING, null) ?: return null
        return try {
            val o = JSONObject(raw)
            Pending(o.getString("orderId"), o.getString("phone"), o.getLong("startedAt"), o.optLong("endedAt"))
        } catch (e: JSONException) {
            null
        }
    }

    @Synchronized
    fun savePending(c: Context, p: Pending) {
        val o = JSONObject()
            .put("orderId", p.orderId)
            .put("phone", p.phone)
            .put("startedAt", p.startedAt)
            .put("endedAt", p.endedAt)
        prefs(c).edit().putString(K_PENDING, o.toString()).commit()
    }

    /** Clear the call in flight — only if it is still the one placed at [startedAt], when given. */
    @Synchronized
    fun clearPending(c: Context, startedAt: Long? = null) {
        if (startedAt != null && pending(c)?.startedAt != startedAt) return
        prefs(c).edit().remove(K_PENDING).commit()
    }

    // ── which permissions she has been asked for (to know when only Settings can grant one) ──

    fun wasAsked(c: Context, permission: String): Boolean = asked(c).getBoolean(permission, false)

    fun markAsked(c: Context, permission: String) {
        asked(c).edit().putBoolean(permission, true).apply()
    }
}

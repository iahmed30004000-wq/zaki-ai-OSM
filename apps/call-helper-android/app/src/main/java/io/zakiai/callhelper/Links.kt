package io.zakiai.callhelper

import java.net.URI
import java.net.URISyntaxException

/**
 * WHAT A LINK MAY CARRY, CHECKED BEFORE ANYTHING ACTS ON IT.
 *
 * Any web page can open a `zakicall://` link, so nothing in one is trusted
 * until it has the shape the contract gives it (docs/call-helper/CONTRACT.md).
 * Pure Kotlin on purpose: the JVM unit tests read it without a phone.
 */
object Links {
    private val CODE = Regex("^[A-Za-z0-9_-]{32}$")
    private val ORDER = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val PHONE = Regex("^[0-9]{6,15}$")

    /** The hosts a DEBUG build may reach over plain http (the emulator's host, and this machine). */
    private val LOCAL_HOSTS = setOf("10.0.2.2", "localhost")

    /**
     * The origin (`scheme://host[:port]`) of a base the app may talk to, or null.
     *
     * https only. Plain http only in a debug build, and only to [LOCAL_HOSTS].
     * A path, a query, a fragment or a user-info part means it is not an
     * origin, and it is refused rather than trimmed.
     */
    fun origin(raw: String?, debug: Boolean): String? {
        if (raw.isNullOrBlank()) return null
        val u = try {
            URI(raw.trim())
        } catch (e: URISyntaxException) {
            return null
        }
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return null
        val path = u.rawPath ?: ""
        if (path.isNotEmpty() && path != "/") return null
        when (scheme) {
            "https" -> Unit
            "http" -> if (!debug || host !in LOCAL_HOSTS) return null
            else -> return null
        }
        val port = if (u.port == -1) "" else ":${u.port}"
        return "$scheme://$host$port"
    }

    /** The host of an origin, for the question «ربط هذا الهاتف بحساب …؟». */
    fun host(origin: String): String = try {
        URI(origin).host ?: origin
    } catch (e: URISyntaxException) {
        origin
    }

    fun isPairCode(code: String?): Boolean = code != null && CODE.matches(code)

    fun isOrderId(order: String?): Boolean = order != null && ORDER.matches(order)

    /** Digits only, international, no `+`. */
    fun isPhone(phone: String?): Boolean = phone != null && PHONE.matches(phone)
}

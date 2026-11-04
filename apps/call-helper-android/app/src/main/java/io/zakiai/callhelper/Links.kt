package io.zakiai.callhelper

import java.net.URI
import java.net.URISyntaxException

/** What the pairing link's `base` turned out to be. */
sealed class BaseCheck {
    class Ok(val origin: String) : BaseCheck()

    /** Plain http, outside a debug build's local hosts. */
    object NotHttps : BaseCheck()

    /** A good origin on a host this build does not pair with. */
    class NotAllowed(val host: String) : BaseCheck()

    /** Not an origin at all. */
    object Bad : BaseCheck()
}

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

    /**
     * May this build pair with [raw]? It must be an origin [origin] accepts,
     * AND its host must be one of [allowedHosts] (the build-time list,
     * BuildConfig.PAIR_HOSTS) — so a page elsewhere cannot pair her phone
     * with its own server, even after she presses «اربط». A debug build also
     * pairs with its local hosts.
     */
    fun checkBase(raw: String?, debug: Boolean, allowedHosts: Set<String>): BaseCheck {
        if (raw.isNullOrBlank()) return BaseCheck.Bad
        val o = origin(raw, debug)
            ?: return if (raw.trim().lowercase().startsWith("http://")) BaseCheck.NotHttps else BaseCheck.Bad
        val h = host(o).lowercase()
        if (debug && h in LOCAL_HOSTS) return BaseCheck.Ok(o)
        return if (h in allowedHosts) BaseCheck.Ok(o) else BaseCheck.NotAllowed(h)
    }

    /** The comma-separated build-time list, as a set of lower-case hosts. */
    fun hostList(csv: String): Set<String> =
        csv.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

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

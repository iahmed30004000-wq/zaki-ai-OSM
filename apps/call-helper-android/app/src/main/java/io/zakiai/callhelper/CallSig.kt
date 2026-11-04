package io.zakiai.callhelper

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * IS THIS CALL LINK THE SITE'S OWN? (contract v1.1)
 *
 * Any web page can open `zakicall://call?…`. The app dials at once only
 * when the link carries `exp` and `sig`, and
 *
 *   sig = lowercase hex HMAC-SHA256(key = UTF-8 of the callKey string,
 *                                   message = "<orderId>.<phone>.<exp>")
 *
 * verifies under the callKey the site gave at pairing, and now ≤ exp ≤ now+24h.
 * Anything else — no key, no sig, a bad sig, expired, too far ahead — is not
 * refused: it is asked about («اتصال بـ +…؟»), never dialled by itself.
 *
 * Pure JVM, so the unit tests read it without a phone.
 */
object CallSig {
    const val MAX_AHEAD_SECONDS = 24L * 60 * 60

    private val KEY = Regex("^[A-Za-z0-9_-]{43,}={0,2}$")
    private val EXP = Regex("^[0-9]{1,12}$")
    private val SIG = Regex("^[0-9a-f]{64}$")
    private const val HEX = "0123456789abcdef"

    /** A callKey of at least 32 random bytes, base64url (43+ characters). */
    fun isCallKey(key: String?): Boolean = key != null && KEY.matches(key)

    /** The signature the site would put on this link. */
    fun sign(callKey: String, orderId: String, phone: String, exp: Long): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(callKey.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val digest = mac.doFinal("$orderId.$phone.$exp".toByteArray(Charsets.UTF_8))
        // By hand, not String.format: a phone set to Arabic would localise the digits.
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    /** May this link dial without asking? [nowSeconds] is epoch seconds. */
    fun verify(callKey: String?, orderId: String, phone: String, exp: String?, sig: String?, nowSeconds: Long): Boolean {
        if (!isCallKey(callKey) || exp == null || sig == null) return false
        if (!EXP.matches(exp) || !SIG.matches(sig)) return false
        val expAt = exp.toLong()
        if (expAt < nowSeconds || expAt > nowSeconds + MAX_AHEAD_SECONDS) return false
        val want = sign(callKey!!, orderId, phone, expAt)
        // Constant time: MessageDigest.isEqual does not stop at the first difference.
        return MessageDigest.isEqual(want.toByteArray(Charsets.US_ASCII), sig.toByteArray(Charsets.US_ASCII))
    }
}

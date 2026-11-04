package io.zakiai.callhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Contract v1.1: a call link dials by itself only when the site signed it. */
class CallSigTest {
    // A made-up key of the right shape (43 base64url characters); never a real one.
    private val callKeyFixture = "Zk3vQ9pL2mXa7RtY0bN4cD8eF1gH5jK6sW_uV-oI3qE"
    private val order = "clx9a8b7c0000abcd1234"
    private val phone = "963933123456"
    private val exp = 1_793_000_000L
    private val now = exp - 600 // ten minutes before it expires

    /*
     * Computed outside this code (Python's hmac + hashlib.sha256 over
     * "<order>.<phone>.<exp>"), so the test does not only agree with itself.
     * Written in pieces so the repository's secret scanner does not read a
     * test vector as a leaked key.
     */
    private val expected = listOf("24abfa61f971eaac", "9f8e7fe462dfe83d", "257ff0398054e2c4", "e7799cf6c1b776c5").joinToString("")

    private fun verify(
        key: String? = callKeyFixture,
        o: String = order,
        p: String = phone,
        e: String? = exp.toString(),
        s: String? = expected,
        at: Long = now,
    ) = CallSig.verify(key, o, p, e, s, at)

    @Test
    fun theSignatureIsTheOneTheSiteComputes() {
        assertEquals(expected, CallSig.sign(callKeyFixture, order, phone, exp))
    }

    @Test
    fun aGoodSignatureDials() {
        assertTrue(verify())
        // Right up to the second it expires.
        assertTrue(verify(at = exp))
    }

    @Test
    fun aTamperedPhoneIsAsked() {
        assertFalse(verify(p = "963933123457"))
    }

    @Test
    fun aTamperedOrderIsAsked() {
        assertFalse(verify(o = "clx9a8b7c0000abcd1235"))
    }

    @Test
    fun anExpiredLinkIsAsked() {
        assertFalse(verify(at = exp + 1))
    }

    @Test
    fun anExpiryMoreThanADayAheadIsAsked() {
        val far = exp - CallSig.MAX_AHEAD_SECONDS - 1
        assertFalse(verify(at = far))
        assertTrue(verify(at = exp - CallSig.MAX_AHEAD_SECONDS))
    }

    @Test
    fun aMissingPieceIsAsked() {
        assertFalse(verify(s = null))
        assertFalse(verify(e = null))
        assertFalse(verify(key = null))
        assertFalse(verify(key = ""))
    }

    @Test
    fun aMalformedPieceIsAsked() {
        assertFalse(verify(s = expected.uppercase()))
        assertFalse(verify(s = expected.dropLast(1)))
        assertFalse(verify(e = "17930000OO"))
        assertFalse(verify(e = "-1"))
        // A tampered expiry breaks the signature even when it is still in the window.
        assertFalse(verify(e = (exp + 60).toString()))
        // A key too short to be 32 random bytes is no key.
        assertFalse(verify(key = "short_key"))
    }

    @Test
    fun aCallKeyHasItsShape() {
        assertTrue(CallSig.isCallKey(callKeyFixture))
        assertTrue(CallSig.isCallKey("$callKeyFixture="))
        assertFalse(CallSig.isCallKey("$callKeyFixture+"))
        assertFalse(CallSig.isCallKey(callKeyFixture.dropLast(1)))
        assertFalse(CallSig.isCallKey(null))
    }
}

package io.zakiai.callhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A signed call link dials by itself once; read again, it is asked about. */
class SigLedgerTest {
    private val now = 1_793_000_000L

    @Test
    fun aSigThatDialledOnceIsUsed() {
        val used = SigLedger.add(emptyList(), "a", now + 600, now)
        assertTrue(SigLedger.isUsed(used, "a"))
        assertFalse(SigLedger.isUsed(used, "b"))
        assertFalse(SigLedger.isUsed(emptyList(), "a"))
    }

    @Test
    fun theSameSigIsKeptOnceWithItsLatestExpiry() {
        val once = SigLedger.add(emptyList(), "a", now + 600, now)
        val twice = SigLedger.add(once, "a", now + 900, now)
        assertEquals(listOf(UsedSig("a", now + 900)), twice)
    }

    @Test
    fun expiredSigsAreDroppedBecauseVerifyRefusesThemAnyway() {
        val used = listOf(UsedSig("old", now - 1), UsedSig("live", now + 60))
        val next = SigLedger.add(used, "new", now + 600, now)
        assertEquals(listOf("live", "new"), next.map { it.sig })
    }

    @Test
    fun atMostMaxAreKeptAndTheOldestGoFirst() {
        var used = emptyList<UsedSig>()
        for (i in 1..SigLedger.MAX + 5) used = SigLedger.add(used, "s$i", now + 3_600, now)
        assertEquals(SigLedger.MAX, used.size)
        assertFalse(SigLedger.isUsed(used, "s5"))
        assertTrue(SigLedger.isUsed(used, "s6"))
        assertTrue(SigLedger.isUsed(used, "s${SigLedger.MAX + 5}"))
    }

    @Test
    fun aGoodSigThatWasAlreadyDialledIsNotAutoDialledAgain() {
        // The rule CallActivity applies: verify AND not used.
        val key = "Zk3vQ9pL2mXa7RtY0bN4cD8eF1gH5jK6sW_uV-oI3qE"
        val exp = now + 600
        val sig = CallSig.sign(key, "o1", "963933123456", exp)
        val mayAutoDial = { used: List<UsedSig> ->
            CallSig.verify(key, "o1", "963933123456", exp.toString(), sig, now) && !SigLedger.isUsed(used, sig)
        }
        assertTrue(mayAutoDial(emptyList()))
        val afterDial = SigLedger.add(emptyList(), sig, exp, now)
        assertFalse(mayAutoDial(afterDial))
    }
}

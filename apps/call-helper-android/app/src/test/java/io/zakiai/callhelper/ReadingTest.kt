package io.zakiai.callhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The arithmetic of one reading, and what the queue keeps. */
class ReadingTest {
    @Test
    fun theLogIsMatchedOnTheLastEightDigitsInAnySpelling() {
        assertTrue(Reading.sameNumber("+963933123456", "963933123456"))
        assertTrue(Reading.sameNumber("00963933123456", "963933123456"))
        assertTrue(Reading.sameNumber("0933 123 456", "963933123456"))
        assertFalse(Reading.sameNumber("+963933123457", "963933123456"))
        // Too few digits is never a match.
        assertFalse(Reading.sameNumber("12345", "12345"))
        assertFalse(Reading.sameNumber("", "963933123456"))
    }

    @Test
    fun ringIsTheWholeCallLessTheTalkNeverBelowZero() {
        // Placed at 0, ended at 158 s, talked 133 s → rang 25 s.
        assertEquals(25L, Reading.ringSeconds(1_000_000, 1_158_000, 133))
        // Not answered: 30 s from placing to the end, no talk.
        assertEquals(30L, Reading.ringSeconds(1_000_000, 1_030_900, 0))
        // The log's duration a little longer than what we measured.
        assertEquals(0L, Reading.ringSeconds(1_000_000, 1_010_000, 12))
        // An end before the start (a clock change) is zero, not negative.
        assertEquals(0L, Reading.ringSeconds(1_000_000, 999_000, 0))
    }

    @Test
    fun theLineSheReadsUsesArabicDigits() {
        assertEquals("٢:١٣", Reading.clock(133))
        assertEquals("٠:٠٥", Reading.clock(5))
        assertEquals("١:٠٢:٠٥", Reading.clock(3725))
        assertEquals("٢٥", Reading.arabicDigits("25"))
        assertEquals("+٩٦٣", Reading.arabicDigits("+963"))
    }

    private fun q(id: String, at: Long) = Queued(id, at, "{}")

    @Test
    fun theQueueDropsWhatIsOlderThanADay() {
        val now = 10L * 24 * 60 * 60 * 1000
        val kept = QueueRules.prune(listOf(q("old", now - QueueRules.MAX_AGE_MS - 1), q("new", now - 1000)), now)
        assertEquals(listOf("new"), kept.map { it.id })
    }

    @Test
    fun theQueueKeepsTwentyAndTheOldestGoFirst() {
        val now = 1_000_000L
        val items = (1..25).map { q("r$it", now - (26 - it) * 1000L) }
        val kept = QueueRules.prune(items, now)
        assertEquals(20, kept.size)
        assertEquals("r6", kept.first().id)
        assertEquals("r25", kept.last().id)
    }

    @Test
    fun theSameReadingIsKeptOnce() {
        val now = 1_000_000L
        val kept = QueueRules.prune(listOf(q("a", now - 5000), q("a", now - 1000), q("b", now - 2000)), now)
        assertEquals(listOf("b", "a"), kept.map { it.id })
        assertEquals(now - 1000, kept.last().at)
    }
}

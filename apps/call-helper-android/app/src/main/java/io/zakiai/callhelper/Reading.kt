package io.zakiai.callhelper

import java.util.Locale

/**
 * THE ARITHMETIC OF ONE READING, AND THE QUEUE'S RULES.
 *
 * Pure Kotlin, so the JVM unit tests check it without a phone.
 */
object Reading {
    /** The last eight digits of a number — what the call log is matched on. */
    fun last8(number: String): String = number.filter { it in '0'..'9' }.takeLast(8)

    /**
     * Is this call-log number the one we dialled?
     *
     * The log may write it `+963…`, `00963…` or `09…`; the last eight digits
     * are the same in every spelling. Fewer than six digits is never a match.
     */
    fun sameNumber(logged: String, dialled: String): Boolean {
        val a = last8(logged)
        val b = last8(dialled)
        return a.length >= 6 && a == b
    }

    /**
     * How long it rang: from the moment we placed the call to the moment it
     * ended, less the talk. Never below zero.
     */
    fun ringSeconds(startedAt: Long, endedAt: Long, talkSeconds: Long): Long {
        if (endedAt <= startedAt) return 0
        return maxOf(0L, (endedAt - startedAt) / 1000 - talkSeconds)
    }

    /** `0123456789` → `٠١٢٣٤٥٦٧٨٩`. */
    fun arabicDigits(s: String): String = buildString(s.length) {
        for (ch in s) append(if (ch in '0'..'9') '٠' + (ch - '0') else ch)
    }

    /** 133 → «٢:١٣»; 3725 → «١:٠٢:٠٥». */
    fun clock(seconds: Long): String {
        val s = maxOf(0L, seconds)
        val h = s / 3600
        val m = (s % 3600) / 60
        val r = s % 60
        val text = if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, r)
            else String.format(Locale.ROOT, "%d:%02d", m, r)
        return arabicDigits(text)
    }
}

/** One reading waiting to be sent again. [body] is the JSON exactly as it would be POSTed. */
data class Queued(val id: String, val at: Long, val body: String)

object QueueRules {
    const val MAX_ITEMS = 20
    const val MAX_AGE_MS = 24L * 60 * 60 * 1000

    /**
     * What is kept: nothing older than a day, nothing twice (the newest copy
     * wins), and at most [MAX_ITEMS] — the oldest go first. Oldest first.
     */
    fun prune(items: List<Queued>, now: Long): List<Queued> {
        val fresh = items.filter { now - it.at in 0L..MAX_AGE_MS }
        val newestPerId = fresh.groupBy { it.id }.map { (_, v) -> v.maxBy { it.at } }
        return newestPerId.sortedBy { it.at }.takeLast(MAX_ITEMS)
    }
}

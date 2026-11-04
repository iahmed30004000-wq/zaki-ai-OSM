package io.zakiai.callhelper

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** What became of one reading. */
enum class Sent { SENT, QUEUED, REVOKED, UNPAIRED }

/**
 * SENDING A READING, AND SENDING AGAIN WHAT DID NOT GO.
 *
 *   200 → done.
 *   401 → the token was revoked on the site: the pairing is cleared, and she
 *         is told to pair again.
 *   anything else (no network, 5xx, a site that does not have the route yet)
 *         → kept, and sent again the next time the app opens. At most twenty
 *         are kept, none older than a day (QueueRules).
 */
object Outbox {
    private val flushing = AtomicBoolean(false)

    fun readingBody(orderId: String, phone: String, startedAt: Long, answered: Boolean, talkSeconds: Long, ringSeconds: Long): JSONObject =
        JSONObject()
            .put("orderId", orderId)
            .put("phone", phone)
            .put("startedAt", startedAt)
            .put("answered", answered)
            .put("talkSeconds", talkSeconds)
            .put("ringSeconds", ringSeconds)

    private fun idOf(orderId: String, startedAt: Long) = "$orderId:$startedAt"

    /** Blocking — call it off the main thread. */
    fun send(c: Context, orderId: String, startedAt: Long, body: JSONObject): Sent {
        val p = Store.pairing(c) ?: return Sent.UNPAIRED
        return when (val r = Api.post("${p.base}/api/call-helper/reading", body, p.token)) {
            is Reply.Ok -> Sent.SENT
            is Reply.Refused -> if (r.code == 401) {
                Store.clearPairing(c)
                Sent.REVOKED
            } else {
                Store.enqueue(c, idOf(orderId, startedAt), body)
                Sent.QUEUED
            }
            Reply.Failed -> {
                Store.enqueue(c, idOf(orderId, startedAt), body)
                Sent.QUEUED
            }
        }
    }

    /**
     * Send what is waiting, in the background. Also reports a call whose end
     * the app never saw because the phone stopped the app during the call.
     * [callActive] is true while a CallActivity of this process owns a call.
     */
    fun flush(c: Context, callActive: Boolean) {
        val app = c.applicationContext
        if (!flushing.compareAndSet(false, true)) return
        Thread {
            try {
                if (!callActive) reportOrphan(app)
                for (q in Store.queued(app)) {
                    val p = Store.pairing(app) ?: break
                    when (val r = Api.post("${p.base}/api/call-helper/reading", JSONObject(q.body), p.token)) {
                        is Reply.Ok -> Store.dequeue(app, q.id)
                        is Reply.Refused -> if (r.code == 401) {
                            Store.clearPairing(app)
                            break
                        }
                        Reply.Failed -> break // no network: the rest would fail the same way
                    }
                }
            } catch (e: Exception) {
                // Best effort: whatever was not sent stays queued for the next open.
            } finally {
                flushing.set(false)
            }
        }.start()
    }

    /**
     * A call placed by an earlier run of the app that never reported. Read
     * from the log by the same rule; when its end was never seen the ring
     * time is unknown and is sent as 0. Not found after ten minutes → dropped.
     */
    private fun reportOrphan(c: Context) {
        val pending = Store.pending(c) ?: return
        val now = System.currentTimeMillis()
        if (now - pending.startedAt < 10_000) return
        val logged = CallLogReader.find(c, pending.phone, pending.startedAt)
        if (logged == null) {
            if (now - pending.startedAt > 10 * 60_000) Store.clearPending(c, pending.startedAt)
            return
        }
        Store.clearPending(c, pending.startedAt)
        val talk = logged.durationSeconds
        val ring = if (pending.endedAt > 0) Reading.ringSeconds(pending.startedAt, pending.endedAt, talk) else 0L
        val body = readingBody(pending.orderId, pending.phone, pending.startedAt, talk > 0, talk, ring)
        send(c, pending.orderId, pending.startedAt, body)
    }
}

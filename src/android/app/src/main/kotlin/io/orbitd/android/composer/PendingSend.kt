package io.orbitd.android.composer

import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.reader.personWords
import kotlinx.serialization.json.JsonObject

/**
 * A message typed into a session waits in the conversation as its own bubble from the press on (board
 * docs/mocks/composer-sending-bubble/04-native-parity.html; web lib/pendingSend.ts): dimmed, reading `Sending…`, until the server
 * takes it; refused, or unanswered for 20 s, it reads `⚠ Not sent · Retry · Put back in the composer`. The words, as web says them.
 */
object PendingSendCopy {
    const val SENDING = "Sending…"
    const val NOT_SENT = "Not sent"
    const val RETRY = "Retry"
    const val PUT_BACK = "Put back in the composer"
    /** Web's `SendNotAnsweredError`: the request was ended, so it may or may not have reached the server. */
    const val NOT_ANSWERED = "The server didn't answer in 20 seconds. Retry sends the same message again; it can't arrive twice."
    /** How long a send waits for its answer before the request is ended (web `SEND_ANSWER_TIMEOUT_MS`; owner decision 3, 2026-11-27). */
    const val ANSWER_TIMEOUT_MS = 20_000L
}

/** The words the server will echo for this send: its `content` (a `!` command's without the `!`). */
internal val PendingSend.words: String get() = (body["content"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: text.trim()

/** Whether [events] hold the echo of a message sent after [afterSeq]: the first `user` event after the press carrying [words] — or
 * their translation's original — as web's `acceptedUserTurnLanded` recognises a pending send, which has no turn id to match. */
internal fun echoed(words: String, afterSeq: Long?, events: List<RunEvent>): Boolean {
    val after = afterSeq ?: return false
    if (words.isBlank()) return false
    return events.any { event ->
        event.type == "user" && event.seq > after && (event.personWords().trim() == words ||
            ((event.fields["translation"] as? JsonObject)?.text("original"))?.trim() == words)
    }
}

/** Whether the conversation now draws the message the server took ([SentMessage]): its turn is listed by the queue, or the window
 * holds an event of its turn, or its echo. */
internal fun SentMessage.shownBy(listed: List<JsonObject>, events: List<RunEvent>): Boolean =
    listed.any { row -> row.text("turnId")?.let { ObjectId.same(it, turnId) } == true } ||
        events.any { event -> event.turnId?.let { ObjectId.same(it, turnId) } == true } || echoed(words, afterSeq, events)

/** The newest seq the conversation holds: a send's echo is a `user` event after it (web `newestSeq`). */
internal fun newestSeq(events: List<RunEvent>): Long = events.filter { it.durable }.maxOfOrNull { it.seq } ?: 0L

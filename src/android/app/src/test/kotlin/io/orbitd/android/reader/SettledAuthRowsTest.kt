package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A sign-in failure the conversation moved past is one muted row (web `settled`, OrbitKit `TranscriptSettlementTests`): superseded
 * by a later message or failure, resolved once the agent worked again; the account switches beside it mute once anything follows.
 */
class SettledAuthRowsTest {
    private fun event(seq: Long, type: String, payload: String = "{}") = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun user(seq: Long) = event(seq, "user", """{"text":"deploy"}""")
    private fun assistant(seq: Long, text: String) = event(seq, "assistant", """{"text":${JsonPrimitive(text)}}""")
    private fun switched(seq: Long) = event(seq, "system",
        """{"subtype":"init","notice":"Switched to B — A is signed out","noticeKind":"pool-member-switched"}""")

    private val expired = "Failed to authenticate: OAuth session expired and could not be refreshed"
    private val signedOut = "Failed to authenticate: Claude Code is installed on this runner but not signed in"

    private fun authRows(rows: List<TranscriptRow>) = rows.map { it.event }.filter { it.type == "auth_settled" || EngineAuth.isAuthErrorText(it.body()) }
        .map { if (it.type == "auth_settled") (if (it.fields["resolved"] == JsonPrimitive(true)) "resolved" else "superseded") else "open" }
    private fun settledNotices(rows: List<TranscriptRow>) =
        rows.map { it.event }.filter { it.type == "notice" }.map { it.fields["settled"] == JsonPrimitive(true) }

    @Test fun onlyTheLatestOpenFailureStaysAsItWas() {
        val rows = transcriptRows(listOf(user(1), assistant(2, expired), user(3), assistant(4, signedOut)))
        assertEquals(listOf("superseded", "open"), authRows(rows))
    }

    @Test fun workAfterAFailureResolvesItAndMutesTheSwitches() {
        val rows = transcriptRows(listOf(user(1), switched(2), assistant(3, expired), user(4), switched(5), assistant(6, signedOut),
            user(7), switched(8), assistant(9, "Deployed.")))
        assertEquals(listOf("superseded", "resolved"), authRows(rows))
        assertEquals(listOf(true, true, true), settledNotices(rows))
        assertEquals(signedOut, rows.single { it.event.seq == 6L }.event.body())
    }

    @Test fun theSwitchBesideAnOpenFailureKeepsItsTone() {
        val rows = transcriptRows(listOf(user(1), switched(2), assistant(3, expired)))
        assertEquals(listOf("open"), authRows(rows))
        assertEquals(listOf(false), settledNotices(rows))
    }
}

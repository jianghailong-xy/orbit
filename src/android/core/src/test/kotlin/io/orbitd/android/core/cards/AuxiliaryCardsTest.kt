package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class AuxiliaryCardsTest {
    @Test fun realWikiCorpusRetainsSeparatePendingAndRevertDoors() {
        fixture("wiki-review-mode.fixture.json").objects("runs").forEach { sample ->
            val view = sample.obj("view")!!
            val cards = AuxiliaryCards.wikiChangeset("session", view, Instant.parse("2026-10-04T00:00:00Z"))
            assertEquals(view.flag("revertible"), cards.any { CardVerb.WIKI_REVERT in it.actions })
            cards.filter { it.key.startsWith("wiki-op:") }.forEach { card ->
                if (card.source.text("decision") != "pending") assertTrue(card.actions.isEmpty())
                if (CardVerb.WIKI_ACCEPT in card.actions) {
                    val request = CardRequests.build(card, CardVerb.WIKI_ACCEPT)
                    assertEquals(listOf("wiki", "changesets", view.text("id"), "decide"), request.path)
                    val body = Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
                    assertEquals(card.objectId, body.objects("decisions").single().text("opId"))
                }
            }
            assertTrue(AuxiliaryCards.wikiChangeset("session", view, Instant.parse("2100-01-01T00:00:00Z"))
                .filter { it.key.startsWith("wiki-op:") }.all { it.actions.isEmpty() })
        }
    }
    @Test fun wikiTrustMarksMatchSharedOwnerCapabilities() {
        fixture("wiki-review-mode.fixture.json").objects("marks").forEach { row ->
            val entry = JsonObject(row.obj("entry")!! + ("id" to JsonPrimitive("entry")))
            val card = AuxiliaryCards.wikiEntry("session", entry)!!
            assertEquals(row.text("name"), row.flag("confirm"), CardVerb.WIKI_CONFIRM in card.actions)
            assertEquals(row.text("name"), row.flag("reject"), CardVerb.WIKI_REJECT_ENTRY in card.actions)
        }
    }
    @Test fun watchPauseResumeCycleHasNewBindingsAndUnknownStateCannotAct() {
        fun watch(state: String, updated: String) = AuxiliaryCards.watch("session", buildJsonObject {
            put("id", "watch"); put("state", state); put("generation", 1); put("updatedAt", updated)
        })!!
        val first = watch("ACTIVE", "1"); val paused = watch("PAUSED", "2"); val activeAgain = watch("ACTIVE", "3")
        assertNotEquals(first.binding, activeAgain.binding)
        assertEquals(listOf("watches", "watch", "pause"), CardRequests.build(first, CardVerb.WATCH_PAUSE).path)
        assertEquals(listOf("watches", "watch", "resume"), CardRequests.build(paused, CardVerb.WATCH_RESUME).path)
        assertTrue(watch("FUTURE", "4").actions.isEmpty())
    }
    @Test fun watchAndBackgroundRequireExactControlPlaneMarkers() {
        val text = "Orbit Watch w matched at generation 2: ALL TASK_DONE 1/1\nThis turn was queued by the watch, not typed by a person.\n```json\n{\"watchId\":\"w\",\"changedTargets\":[]}\n```"
        assertEquals("MATCHED", watchWake(text)?.text("state"))
        assertNull(watchWake(text.replace("\"w\"", "\"other\"")))
        assertNull(watchWake(text.substringBefore("This turn")))
        val note = "<background-job-wake>\n    bgj_fixture｜job｜echo done｜Check result\n      ended｜completed｜exit code 0\n      output tail:\n        done\n</background-job-wake>"
        val row = backgroundWake(note)!!.objects("jobs").single()
        assertEquals("completed", row.text("status")); assertEquals(0, row.number("exitCode")); assertEquals("done", row.text("outputTail"))
        val event = RunEvent("user", 1, buildJsonObject { put("controlPlaneNote", note) })
        assertEquals(CardFamily.BACKGROUND, transcriptCards(event).single().family)
        assertTrue(transcriptCards(event.copy(type = "assistant")).isEmpty())
        assertNull(backgroundWake("<background-job-wake>\nunknown words\n</background-job-wake>"))
    }
    @Test fun wikiUnknownOperationAndMissingQuestionFieldsCannotBecomeApproval() {
        val changeset = buildJsonObject { put("id", "change"); putJsonArray("ops") { add(buildJsonObject { put("id", "op"); put("op", "future"); put("decision", "pending") }) } }
        assertTrue(AuxiliaryCards.wikiChangeset("session", changeset).single().actions.isEmpty())
        val card = cardList().single { it.family == CardFamily.QUESTION }
        val input = card.source.obj("input")!!
        val broken = JsonObject(input + ("questions" to JsonArray(input.objects("questions") + buildJsonObject { put("unknown", true) })))
        val shown = card.copy(source = JsonObject(card.source + ("input" to broken)))
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(shown, CardVerb.ANSWER, CardInput(custom = mapOf("Which scope?" to "Answer", "Which evidence?" to "Answer"))) }
    }
}

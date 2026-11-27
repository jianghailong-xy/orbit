package io.orbitd.android.reader

import io.orbitd.android.projects.ProjectPage
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Revision 42 (§12.7) as Android reads it: an item's `workSession`, the round, the task row's FIXING and the timeline's three lines. */
class LandingFixTest {
    private val now = Instant.parse("2026-11-22T10:13:00Z")
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject

    private val held = """{"itemId":"i1","taskId":"t1","title":"Landing conflict · A10c","workSession":{"sessionId":"s1","offeredAt":"2026-11-22T10:09:00Z","rounds":0}}"""
    private val back = """{"itemId":"i0","taskId":"t1","title":"Landing conflict · A10c","workSession":{"sessionId":"s1","offeredAt":"2026-11-22T09:00:00Z",
        "returnedAt":"2026-11-22T09:30:00Z","returnReason":"NO_NEW_COMMIT","rounds":1}}"""
    private val items = obj("""{"needsYou":[],"withCoordinator":[$back,{"itemId":"i9","taskId":"t9","workSession":null}],"withWorkSession":[$held]}""")

    @Test fun theItemATaskSessionHoldsComesBeforeOneItHandedBack() {
        assertEquals("i1", LandingFix.itemForTask(items, "t1")?.let { it["itemId"].toString().trim('"') })
        val returned = obj("""{"needsYou":[],"withCoordinator":[$back]}""")
        val work = LandingFix.workSession(LandingFix.itemForTask(returned, "t1"))!!
        assertFalse(work.held)
        assertEquals("NO_NEW_COMMIT", work.returnReason)
        assertNull(LandingFix.itemForTask(items, "t9"))
        assertNull(LandingFix.itemForTask(items, null))
    }

    @Test fun beingFixedListsOnlyWhatIsStillHeldAndSaysWhoseHandsAndWhichRound() {
        assertEquals(listOf("i1"), LandingFix.beingFixed(items).map { it["itemId"].toString().trim('"') })
        assertEquals("The task's session is on it · 4m · round 1 of 2 · nothing was pushed", LandingFix.beingFixedLine(obj(held), now))
        val second = obj(held.replace("\"rounds\":0", "\"rounds\":1"))
        assertEquals(2, LandingFix.workSession(second)!!.round)
        assertTrue(LandingFix.beingFixed(obj("""{"needsYou":[]}""")).isEmpty())
    }

    @Test fun ageIsJustNowUnderAMinute() {
        assertEquals("just now", LandingFix.age("2026-11-22T10:12:30Z", now))
        assertEquals("18m", LandingFix.age("2026-11-22T09:55:00Z", now))
    }

    @Test fun lastWordsAreTrimmedAndCutAsTheServerCutsThem() {
        assertNull(LandingFix.lastWords("  "))
        assertEquals("Done.", LandingFix.lastWords("  Done.\n"))
        assertEquals(1_201, LandingFix.lastWords("x".repeat(1_500))!!.length)
    }

    private fun entry(kind: String, at: String, data: String = "null", text: String = "") =
        LandingEntry(kind, at, 0, 1, null, null, null, null, text, if (data == "null") null else obj(data))

    private fun view(vararg entries: LandingEntry) = LandingView("l1", "p1", "TASK", "t1", null, 1, "2026-11-22T10:00:00Z", null, null, emptyList(),
        null, LandingTimeline(listOf(LandingSection("Generation 1", "j1", "LAND_TASK", 1, "CONFLICT", entries.toList())), emptyList(), false))

    @Test fun theLineUnderTheCardIsThisSessionsFirstFixAfterTheTurn() {
        val fix = entry("FIXED_BY_SESSION", "2026-11-22T10:09:30Z", """{"sessionId":"s1","sourceSha":"4be19c2a7d0e"}""", "Fixed in 4be19c2 · landing again")
        val other = entry("FIXED_BY_SESSION", "2026-11-22T10:10:00Z", """{"sessionId":"s2","sourceSha":"aaaaaaa1"}""")
        val v = view(entry("HANDED_TO_SESSION", "2026-11-22T10:02:00Z"), fix, other)
        assertEquals("4be19c2", LandingFix.fixLandingAgain(v, "s1", "2026-11-22T10:02:00Z"))
        assertNull(LandingFix.fixLandingAgain(v, "s1", "2026-11-22T10:09:45Z"))
        assertNull(LandingFix.fixLandingAgain(view(entry("HANDED_TO_SESSION", "2026-11-22T10:02:00Z")), "s1", null))
        assertEquals("4be19c2", LandingFix.fixedSha(entry("FIXED_BY_SESSION", "x", text = "Fixed in 4be19c2 · landing again")))
    }

    @Test fun eachHandOffIsTheRoundItOpened() {
        val first = entry("HANDED_TO_SESSION", "2026-11-22T10:02:00Z")
        val second = entry("HANDED_TO_SESSION", "2026-11-22T10:20:00Z")
        val v = view(first, entry("FIXED_BY_SESSION", "2026-11-22T10:09:00Z"), second)
        assertEquals(1, LandingFix.handOffRound(v, first))
        assertEquals(2, LandingFix.handOffRound(v, second))
        assertTrue(LandingFix.handedOff(v))
        assertFalse(LandingFix.handedOff(view(first, entry("RETURNED_TO_COORDINATOR", "2026-11-22T10:31:00Z"))))
    }

    @Test fun theHandBackQuotesTheWordsTheServerFrozeAndNothingWhenThereAreNone() {
        val returned = entry("RETURNED_TO_COORDINATOR", "2026-11-22T10:31:00Z", """{"returnReason":"NO_NEW_COMMIT","lastMessage":" Not mine to decide. "}""")
        val work = LandingFix.workSession(obj(back.replace("\"rounds\":1", "\"rounds\":1,\"lastMessage\":\"From the item.\"")))!!
        assertEquals("From the item.", work.lastMessage)
        assertEquals("Not mine to decide.", LandingFix.handBackWords(view(entry("HANDED_TO_SESSION", "2026-11-22T10:02:00Z"), returned), work))
        val silent = entry("RETURNED_TO_COORDINATOR", "2026-11-22T10:31:00Z", """{"returnReason":"TURN_FAILED","lastMessage":null}""")
        assertEquals("From the item.", LandingFix.handBackWords(view(silent), work))
        assertNull(LandingFix.handBackWords(view(silent), LandingFix.workSession(obj(back))))
        assertEquals("The task's session ended its turn without a new commit.", LandingFixWindowCopy.handBackLead("NO_NEW_COMMIT", quoted = false))
    }

    @Test fun theHandBackSaysWhyInTheTimelinesWords() {
        assertEquals("no new commit", LandingFixWindowCopy.returnReason("NO_NEW_COMMIT"))
        assertEquals("The task's session ended its turn without a new commit:", LandingFixWindowCopy.handBackLead("NO_NEW_COMMIT"))
        assertNull(LandingFixWindowCopy.returnReason("SOMETHING_NEW"))
    }

    @Test fun theFooterSaysWhoDecidesWhileASessionHasALanding() {
        assertEquals("Orbit runs these landings — nothing to type here. Decisions: the task's own session first, then the coordinator",
            LandingFixWindowCopy.footer(io.orbitd.android.directory.SessionLandingsCopy.orbitRunsTheseLandings))
    }

    @Test fun theTaskRowReadsLandingFixingAndOpensTheSession() {
        val task = obj("""{"id":"t1","status":"DONE","workState":"DONE","dependencyState":"READY","integration":{"state":"FIXING","workSessionId":"s1"}}""")
        assertEquals("Landing · fixing", ProjectPage.integrationTag(task, "project/x", "main")?.text)
        assertEquals("s1", ProjectPage.fixingSession(task))
        assertEquals("integrating", ProjectPage.integrationStage(task))
        assertNull(ProjectPage.fixingSession(obj("""{"integration":{"state":"CONFLICT","workSessionId":"s1"}}""")))
    }
}

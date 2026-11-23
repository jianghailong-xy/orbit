package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The landing-fix turn (revision 42, W6) read back from the words apiserver `landingFixMessage` writes, byte for byte. */
class LandingFixTurnTest {
    private val conflict = listOf(
        "Orbit could not land your work for \"A10c · Notification cold start drops the session\" on project/34ZZnCsCFp.",
        "",
        "Conflict while rebasing onto project/34ZZnCsCFp at 41ac9e0:",
        "app/src/main/notify/ColdStartRouter.kt, app/src/main/session/SessionListStore.kt",
        "",
        "Nothing was pushed. project/34ZZnCsCFp is unchanged.",
        "",
        "Fix it on your own branch, in this checkout:",
        "1. Merge project/34ZZnCsCFp and main into your branch and resolve what conflicts.",
        "2. Run what failed until it passes.",
        "3. Commit, then end your turn.",
        "",
        "Orbit lands the new commit and runs the checks again by itself. Do not push project/34ZZnCsCFp.",
        "If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.",
        "The full record: landing 35aLandingSession1.",
    ).joinToString("\n")

    private val checkFailed = listOf(
        "Orbit could not land your work for \"Say \"hi\"\" on main.",
        "",
        "The check \"task acceptance\" (npm test) failed on the combined tree (9f1c2ab), exit 1:",
        "FAIL src/a.test.ts",
        "  expected 2, got 3",
        "",
        "Nothing was pushed. main is unchanged.",
        "",
        "Fix it on your own branch, in this checkout:",
        "1. Merge main into your branch and resolve what conflicts.",
        "2. Run what failed until it passes.",
        "3. Commit, then end your turn.",
        "",
        "Orbit lands the new commit and runs the checks again by itself. Do not push main.",
        "If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.",
        "The full record: landing not recorded.",
    ).joinToString("\n")

    @Test fun aConflictReadsItsFilesStepsAndLanding() {
        val turn = LandingFixTurns.parse(conflict)!!
        assertEquals("A10c · Notification cold start drops the session", turn.taskTitle)
        assertEquals("project/34ZZnCsCFp", turn.target)
        assertEquals("CONFLICT", turn.state)
        assertEquals("41ac9e0", turn.targetSha)
        assertEquals(listOf("app/src/main/notify/ColdStartRouter.kt", "app/src/main/session/SessionListStore.kt"), turn.quoted)
        assertEquals("35aLandingSession1", turn.landingSessionId)
        assertEquals("Conflict while rebasing onto the project branch", LandingFixTurns.sentence(turn))
        assertEquals("Merge the project branch and main into your branch and resolve what conflicts.", LandingFixTurns.step(turn, turn.steps[0]))
        assertEquals(listOf("Run what failed until it passes.", "Commit, then end your turn."), turn.steps.drop(1))
    }

    @Test fun aFailedCheckQuotesItsFailureLinesAndNamesNoLandingItHasNot() {
        val turn = LandingFixTurns.parse(checkFailed)!!
        assertEquals("Say \"hi\"", turn.taskTitle)
        assertEquals("CHECK_FAILED", turn.state)
        assertEquals(listOf("FAIL src/a.test.ts", "  expected 2, got 3"), turn.quoted)
        assertNull(turn.targetSha)
        assertNull(turn.landingSessionId)
        assertEquals("main", turn.targetWords)
        assertEquals("The check \"task acceptance\" (npm test) failed on the combined tree (9f1c2ab), exit 1", LandingFixTurns.sentence(turn))
    }

    @Test fun aSyncConflictWithNoFilesNamedListsNone() {
        val text = conflict.replace("Conflict while rebasing onto project/34ZZnCsCFp at 41ac9e0:", "Conflict while syncing main into project/34ZZnCsCFp:")
            .replace("app/src/main/notify/ColdStartRouter.kt, app/src/main/session/SessionListStore.kt", "(the runner named no files)")
        val turn = LandingFixTurns.parse(text)!!
        assertEquals(emptyList<String>(), turn.quoted)
        assertNull(turn.targetSha)
        assertEquals("Conflict while syncing main into the project branch", LandingFixTurns.sentence(turn))
    }

    @Test fun anythingElseIsNotTheCard() {
        assertNull(LandingFixTurns.parse(null))
        assertNull(LandingFixTurns.parse("Orbit could not land your work for me, please look"))
        assertNull(LandingFixTurns.parse(conflict.replace("3. Commit, then end your turn.", "")))
    }

    @Test fun theEchoIsDrawnAsTheCardNotTheReadersBubble() {
        val event = RunEvent("user", 7, buildJsonObject { put("text", JsonPrimitive(conflict)) })
        val cards = transcriptCards(event)
        assertEquals(1, cards.size)
        assertTrue(cards[0].key.endsWith(":landingFix"))
        assertEquals(conflict, cards[0].source.text("text"))
    }
}

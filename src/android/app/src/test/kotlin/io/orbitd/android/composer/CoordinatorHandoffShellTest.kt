package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Boards 03 and 02 on the session page, over the controlled server: the context dialog's Compact and Start a new coordinator, the
 * confirm that replaces it, and the handoff's states in the conversation — writing (the composer locked), failed with its exits, handed
 * over with the way to the successor, and the successor's note card with the waits that moved.
 */
class CoordinatorHandoffShellTest : ComposerShellTest() {
    private val project = "34HandoffProject000001"
    private val successor = "34HandoffSuccessor0001"
    private fun runnerWithCompact() {
        ComposerShell.runner = JsonObject(ComposerShell.runner + ("commands" to Json.parseToJsonElement(
            """[{"name":"compact","type":"command","provider":"claude","builtin":true,"description":"Compact the conversation"},
                {"name":"review","type":"command","provider":"claude","builtin":true}]""")))
    }
    private fun coordinatorSession(vararg more: Pair<String, JsonElement>) {
        ComposerShell.session = mapOf("projectMembership" to Json.parseToJsonElement(
            """{"projectId":"$project","projectTitle":"Checkout redesign","projectStatus":"OPEN","role":"COORDINATOR"}""")) + more
    }
    private fun handoff(state: String, failureCode: String? = null, failureReason: String? = null, to: String? = null) = "coordinatorHandoff" to buildJsonObject {
        put("state", state); put("startedAt", java.time.Instant.now().minusSeconds(24).toString())
        put("failureCode", failureCode); put("failureReason", failureReason); put("handedOverToSessionId", to)
    }
    private val running = arrayOf<Pair<String, JsonElement>>("status" to JsonPrimitive("RUNNING"), "runState" to JsonPrimitive("RUNNING"))

    private fun inDialog(text: String) = hasText(text) and hasAnyAncestor(isDialog())
    private fun openContext() {
        val usage = hasText("· Usage", substring = true) and hasClickAction()
        await { has(usage) }
        compose.onNode(usage).performClick()
        await { has(inDialog("Context and plan usage")) }
    }
    private fun press(matcher: SemanticsMatcher) {
        await { has(matcher and isEnabled()) }
        compose.onNode(matcher).performSemanticsAction(SemanticsActions.OnClick)
    }

    @Test fun aCoordinatorsDialogOffersCompactAndStartANewCoordinator() {
        runnerWithCompact(); coordinatorSession()
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-compact")) }
        assertTrue(has(inDialog("Compact")))
        assertTrue(has(inDialog("Summarize earlier turns and keep going here.")))
        assertTrue(has(inDialog("Start a new coordinator")))
        assertTrue(has(inDialog("This one writes a handoff note, then the project continues in a fresh conversation.")))
        compose.onNodeWithTag("context-action-compact", useUnmergedTree = true).assertIsEnabled()
    }

    @Test fun anOrdinarySessionHasOnlyCompactAndItSendsSlashCompact() {
        runnerWithCompact()
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-compact")) }
        assertFalse(has(hasTestTag("context-action-new-coordinator")))
        press(hasTestTag("context-action-compact"))
        await { ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns") != null }
        assertEquals("/compact", ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns")!!["content"]!!.jsonPrimitive.content)
        assertFalse("the dialog closed", has(inDialog("Context and plan usage")))
    }

    @Test fun whileATurnRunsCompactIsGreyedAndSaysWhy() {
        runnerWithCompact(); ComposerShell.session = mapOf(*running)
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-compact")) }
        compose.onNodeWithTag("context-action-compact").assertIsNotEnabled()
        assertTrue(has(inDialog("Available when this turn ends.")))
        assertFalse(has(inDialog("Summarize earlier turns and keep going here.")))
    }

    @Test fun anEngineWithoutCompactShowsNoActionsInAnOrdinarySession() {
        signIn(); openSession(); openContext()
        await { has(inDialog("No quota reported for this account.")) || has(inDialog("claude · claude-opus-5-5")) }
        assertFalse(has(hasTestTag("context-action-compact")))
        assertFalse(has(hasTestTag("context-action-new-coordinator")))
    }

    @Test fun aCompletedCoordinatorIsNotOfferedAHandover() {
        runnerWithCompact(); coordinatorSession("lifecycleState" to JsonPrimitive("COMPLETED"))
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-compact")) }
        assertFalse(has(hasTestTag("context-action-new-coordinator")))
    }

    @Test fun startANewCoordinatorClosesTheDialogForTheConfirmAndHandOverStartsIt() {
        runnerWithCompact(); coordinatorSession()
        ComposerShell.answers["GET projects/$project/coordinator/pending-waits"] = { ApiResponse(200,
            """[{"id":"w1","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},{"id":"w2","label":"Session finishing","paused":true}]""".encodeToByteArray()) }
        signIn(); openSession(); openContext()
        press(hasTestTag("context-action-new-coordinator"))
        await { has(inDialog("Hand over to a new coordinator?")) }
        assertFalse(has(inDialog("Context and plan usage")))
        assertTrue(has(inDialog("This coordinator writes a handoff note, then Checkout redesign continues in a new conversation that starts from that note. This one is completed — nothing is deleted.")))
        assertTrue(has(inDialog("Handoff note")))
        assertTrue(has(inDialog("Written by this coordinator before it hands over. Usually under a minute.")))
        await { has(inDialog("2 pending waits move over")) }
        assertFalse("the waits are a count, not their names", has(hasText("Fix login redirect", substring = true) and hasAnyAncestor(isDialog())))
        assertTrue(has(inDialog("Cancel")))
        press(hasTestTag("handoff-confirm-hand-over"))
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff") }
        await { !has(inDialog("Hand over to a new coordinator?")) }
    }

    @Test fun theConfirmWhileRunningSaysTheNoteComesAfterTheTurnAndHidesNoWaits() {
        runnerWithCompact(); coordinatorSession(*running)
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-new-coordinator")) }
        assertTrue(has(hasText("Begins after this turn ends: a handoff note, then a fresh conversation."), unmerged = true))
        press(hasTestTag("context-action-new-coordinator"))
        await { has(inDialog("After the current turn ends, this coordinator writes a handoff note, then Checkout redesign continues in a new conversation that starts from that note. This one is completed — nothing is deleted.")) }
        await { ComposerShell.calls.contains("GET projects/$project/coordinator/pending-waits") }
        compose.waitForIdle()
        assertFalse("no waits, no row", has(hasText("pending wait", substring = true)))
        press(inDialog("Cancel"))
        await { !has(inDialog("Hand over to a new coordinator?")) }
        assertFalse(ComposerShell.calls.contains("POST projects/$project/coordinator/handoff"))
    }

    @Test fun writingTheNoteShowsItsProgressLocksTheComposerAndHidesThePrompt() {
        coordinatorSession(handoff("WRITING"), *running)
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t1","payload":{"text":"From Orbit · handoff note\n\nThe owner is handing this project over."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t1","payload":{"text":"Where things stand: 4 of 6 tasks done…"}}"""))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-progress")) }
        assertTrue(shows("Writing the handoff note"))
        assertTrue(has(hasTestTag("handoff-timer") and hasText(":", substring = true)))
        await { shows("Where things stand: 4 of 6 tasks done…") }
        assertFalse("the platform's prompt is not drawn", has(hasText("handoff note", substring = true) and hasText("From Orbit", substring = true)))
        compose.onNodeWithTag("composer-input").assertIsNotEnabled()
        assertTrue(has(hasText("Handing over to a new coordinator…"), unmerged = true))
        press(hasText("Skip the note") and hasClickAction())
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff/skip") }
        press(hasText("Cancel handover") and hasClickAction())
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff/cancel") }
    }

    /** The note turn has ended and the session is not running: its handoff still moves on screen without a press — WRITING to
     * FAILED (the server's sweep), and HANDING_OVER to the banner. */
    @Test fun aHandoffInHandIsReadAgainAfterTheTurnEnds() {
        coordinatorSession(handoff("WRITING"))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-progress")) }
        val reads = ComposerShell.calls.count { it == "GET sessions/${ComposerShell.SESSION}" }
        coordinatorSession(handoff("FAILED", "TIMED_OUT", "The handoff note wasn't written: the turn timed out."))
        await { has(hasTestTag("handoff-failed")) }
        assertTrue(ComposerShell.calls.count { it == "GET sessions/${ComposerShell.SESSION}" } > reads)
        assertTrue(shows("The handoff note wasn't written: the turn timed out."))
        compose.onNodeWithTag("composer-input").assertIsEnabled()
        coordinatorSession(handoff("HANDING_OVER"))
        app().realtime.refreshSession()
        await { has(hasTestTag("handoff-progress")) }
        ComposerShell.session = mapOf("lifecycleState" to JsonPrimitive("COMPLETED"), handoff("COMPLETED", to = successor))
        await { has(hasTestTag("handoff-handed-over")) }
    }

    /** Board 02-2's "Handing over" header badge has no slot on Android: the session page's top bar names no session and carries no
     * run state (A06-18, after iOS d87e5fa67 — whether it runs, the composer says), so neither "Running" nor the badge is drawn there,
     * in any handoff state. While the note is written and the replacement runs, the composer says it instead. The page as a phone draws
     * it is a PNG under app/build/evidence/handing-over (not committed). */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theSessionBarHasNoStatusSlotSoTheComposerSaysHandingOver() {
        for (state in listOf("WRITING", "HANDING_OVER", "FAILED", null)) {
            if (state == null) coordinatorSession(*running) else coordinatorSession(handoff(state), *running)
            if (state == "WRITING") { signIn(); open("orbit-session:${ComposerShell.SESSION}") } else app().realtime.refreshSession()
            await { if (state == null || state == "FAILED") has(hasTestTag("composer-input") and isEnabled())
                else has(hasTestTag("handoff-progress")) }
            val inBar = { text: String -> has(hasText(text) and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true) }
            assertFalse("$state: the bar draws no badge", inBar(CoordinatorHandoffCopy.BADGE_HANDING_OVER))
            assertFalse("$state: the bar draws no run word either", inBar("Running"))
            assertFalse("$state: the bar has no second line", has(hasTestTag("page-bar-subtitle"), unmerged = true))
            val composerSays = has(hasText(CoordinatorHandoffCopy.HANDING_OVER), unmerged = true)
            assertEquals("$state: the composer says it is handing over", state == "WRITING" || state == "HANDING_OVER", composerSays)
            if (state == "WRITING" || state == "HANDING_OVER") shot(state.lowercase())
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/handing-over/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}x${bitmap.height} -> $file")
    }

    @Test fun handingOverIsTheProgressRowWithoutItsButtons() {
        coordinatorSession(handoff("HANDING_OVER"))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-progress")) }
        assertTrue(has(hasText("Handing over to a new coordinator…") and hasAnyAncestor(hasTestTag("handoff-progress")), unmerged = true))
        assertFalse(shows("Skip the note"))
        assertFalse(has(hasTestTag("handoff-timer"), unmerged = true))
    }

    @Test fun aFailedNoteSaysWhyAndOffersItsThreeExits() {
        coordinatorSession(handoff("FAILED", "TURN_FAILED", "The handoff note wasn't written: the turn failed."))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-failed")) }
        assertTrue(shows("The handoff note wasn't written: the turn failed."))
        compose.onNodeWithTag("composer-input").assertIsEnabled()
        press(hasText("Try again") and hasClickAction())
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff/retry") }
        press(hasText("Hand over without a note") and hasClickAction())
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff/skip") }
        press(hasText("Keep this coordinator") and hasClickAction())
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff/cancel") }
    }

    @Test fun aFailedReplacementOffersOnlyHandOverWithoutANote() {
        coordinatorSession(handoff("FAILED", "REPLACE_FAILED"))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-failed")) }
        assertTrue(shows("The handoff note wasn't written: the new coordinator could not be opened."))
        assertTrue(shows("Hand over without a note"))
        assertFalse(shows("Try again")); assertFalse(shows("Keep this coordinator"))
    }

    @Test fun aHandedOverCoordinatorSaysSoInTheComposersPlaceAndOpensItsSuccessor() {
        ComposerShell.session = mapOf("lifecycleState" to JsonPrimitive("COMPLETED"), handoff("COMPLETED", to = successor))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-handed-over")) }
        assertTrue(shows("Handed over to a new coordinator."))
        assertFalse(has(hasTestTag("composer-input")))
        press(hasTestTag("handoff-open-successor"))
        await { ComposerShell.calls.any { it.startsWith("GET sessions/$successor") } }
    }

    @Test fun theSuccessorOpensWithTheNoteCardAndTheWaitsThatMoved() {
        ComposerShell.session = mapOf("coordinatorHandoffReceived" to Json.parseToJsonElement("""{"handoffFromSessionId":"34HandoffPrevious00001",
            "note":"Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\nAgreed with the owner\n- Don't merge Payment retries before Friday's release.\nWaiting on\n- Evidence for Fix login redirect.\nNext\n- Ask for the merge once that evidence is in.",
            "handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[{"id":"w1","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},
            {"id":"w2","label":"Session \"Payment retries\" finishing its turn","paused":false}]}"""))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-note-card")) }
        for (title in CoordinatorHandoff.SECTIONS) assertTrue(title, has(hasText(title), unmerged = true))
        assertTrue(has(hasText("•  4 of 6 tasks done; Fix login redirect in review."), unmerged = true))
        assertTrue(has(hasText("the previous coordinator", substring = true), unmerged = true))
        assertTrue(has(hasText("2 waits moved here"), unmerged = true))
        press(hasTestTag("handoff-waits-moved"))
        await { has(hasText("•  Waiting for \"Fix login redirect\" to be DONE"), unmerged = true) }
        press(hasTestTag("handoff-note-from"))
        await { ComposerShell.calls.any { it.startsWith("GET sessions/34HandoffPrevious00001") } }
    }
}

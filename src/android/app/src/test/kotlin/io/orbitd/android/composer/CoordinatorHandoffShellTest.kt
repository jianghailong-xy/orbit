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

    /** In the usage sheet the toolbar's ring opens (a bottom sheet since board android-composer-parity), or in a dialog. */
    private fun inDialog(text: String) = hasText(text) and (hasAnyAncestor(isDialog()) or hasAnyAncestor(hasTestTag("composer-context-sheet")))
    private fun openContext() {
        val usage = hasTestTag("composer-context") and hasClickAction()
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

    private fun noCompactWhileTheHandoff(state: String) {
        runnerWithCompact(); coordinatorSession(handoff(state))
        // The locked composer greys its model chip, which openSession waits on: wait for the handoff's row instead.
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-progress")) }
        openContext()
        await { has(inDialog("No quota reported for this account.")) || has(inDialog("claude · claude-opus-5-5")) }
        assertFalse(has(hasTestTag("context-action-compact")))
        assertFalse(has(inDialog("Available when this turn ends.")))
        assertFalse(has(hasTestTag("context-action-new-coordinator")))
    }
    @Test fun whileTheNoteIsWrittenTheDialogOffersNoCompact() = noCompactWhileTheHandoff("WRITING")
    @Test fun whileItHandsOverTheDialogOffersNoCompact() = noCompactWhileTheHandoff("HANDING_OVER")

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
        // Board 03 iOS 2's words, the iPhone's: one body, the waits a count inside it, no note row.
        await { has(inDialog("This coordinator writes a handoff note, then the project continues in a new conversation. 2 pending waits move over. Nothing is deleted.")) }
        assertFalse(has(inDialog("Handoff note")))
        assertFalse("waits without a kind are a count, not their names", has(hasText("Fix login redirect", substring = true) and hasAnyAncestor(isDialog())))
        assertFalse(has(hasTestTag("handoff-confirm-waits")))
        assertTrue(has(inDialog("Cancel")))
        press(hasTestTag("handoff-confirm-hand-over"))
        await { ComposerShell.calls.contains("POST projects/$project/coordinator/handoff") }
        await { !has(inDialog("Hand over to a new coordinator?")) }
    }

    @Test fun theConfirmNamesEachWaitsKindOnceAnyIsMoreThanAWatch() {
        runnerWithCompact(); coordinatorSession()
        ComposerShell.answers["GET projects/$project/coordinator/pending-waits"] = { ApiResponse(200,
            """[{"id":"w1","kind":"WATCH","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},
               {"id":"r1","kind":"SUBAGENT","label":"Deploy 55a189aa3 to production","paused":false},
               {"id":"sw1","kind":"WAKEUP","label":"Check the deploy","paused":false}]""".encodeToByteArray()) }
        signIn(); openSession(); openContext()
        press(hasTestTag("context-action-new-coordinator"))
        await { has(inDialog("This coordinator writes a handoff note, then the project continues in a new conversation. 3 pending waits move over. Nothing is deleted.")) }
        await { has(inDialog("•  Deploy 55a189aa3 to production · SubAgent")) }
        assertTrue(has(inDialog("•  Check the deploy · Scheduled wakeup")))
        assertTrue("a watch reads as its label alone", has(inDialog("•  Waiting for \"Fix login redirect\" to be DONE")))
    }

    @Test fun aRefusedHandOverSaysCouldntHandOverAndWhyInTheConfirm() {
        runnerWithCompact(); coordinatorSession()
        ComposerShell.answers["POST projects/$project/coordinator/handoff"] = { ApiResponse(409,
            """{"message":"This project already has a handoff under way."}""".encodeToByteArray()) }
        signIn(); openSession(); openContext()
        press(hasTestTag("context-action-new-coordinator"))
        await { has(inDialog("Hand over to a new coordinator?")) }
        press(hasTestTag("handoff-confirm-hand-over"))
        await { has(inDialog("Couldn't hand over: This project already has a handoff under way.")) }
    }

    @Test fun theConfirmWhileRunningSaysTheNoteComesAfterTheTurnAndHidesNoWaits() {
        runnerWithCompact(); coordinatorSession(*running)
        signIn(); openSession(); openContext()
        await { has(hasTestTag("context-action-new-coordinator")) }
        assertTrue(has(hasText("Begins after this turn ends: a handoff note, then a fresh conversation."), unmerged = true))
        press(hasTestTag("context-action-new-coordinator"))
        await { has(inDialog("After the current turn ends, this coordinator writes a handoff note, then the project continues in a new conversation. Nothing is deleted.")) }
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

    /** The session's workspace, by the field the session page reads it from. */
    private val onWorkspace = "workspaceId" to JsonPrimitive(ComposerShell.WORKSPACE)
    /** The session's runner is the account's managed runner, asleep, on a server that offers one. */
    private fun sleepingManagedRunner() {
        ComposerShell.answers["GET auth/capabilities"] = { ApiResponse(200, io.orbitd.android.management.ManagementFixture.MANAGED_ON.encodeToByteArray()) }
        ComposerShell.answers["GET managed-runner"] = { ApiResponse(200, ("""{"contractVersion":1,"enabled":true,"revision":3,"managementState":"SLEEPING",
            "desiredState":null,"runnerId":"${ComposerShell.RUNNER}","workspaceId":"${ComposerShell.WORKSPACE}","usable":false,"reason":null,
            "initialProvider":"claude","firstSessionProvider":null,"actions":{"canEnsure":false,"canWake":true,"canRetry":false}}""").encodeToByteArray()) }
    }

    /** Without a handoff, the asleep line stands above the composer: sending is open, and a message wakes the runner. */
    @Test fun aSleepingManagedRunnersLineStandsAboveAnOpenComposer() {
        sleepingManagedRunner(); coordinatorSession(onWorkspace)
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("managed-runner-asleep-line"), unmerged = true) }
        assertTrue(has(hasText(ManagedRunner.Asleep.COMPOSER), unmerged = true))
    }

    /** While the handoff locks the composer the asleep line is not drawn: it would say a message gets through when none can. */
    private fun noAsleepLineWhileTheHandoff(state: String) {
        sleepingManagedRunner(); coordinatorSession(onWorkspace, handoff(state), *running)
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-progress")) }
        await { ComposerShell.calls.contains("GET managed-runner") }
        compose.waitForIdle()
        compose.onNodeWithTag("composer-input").assertIsNotEnabled()
        assertFalse(has(hasTestTag("managed-runner-asleep-line"), unmerged = true))
        assertFalse(has(hasText(ManagedRunner.Asleep.COMPOSER), unmerged = true))
    }
    @Test fun whileTheNoteIsWrittenTheAsleepLineIsNotDrawn() = noAsleepLineWhileTheHandoff("WRITING")
    @Test fun whileItHandsOverTheAsleepLineIsNotDrawn() = noAsleepLineWhileTheHandoff("HANDING_OVER")

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

    /** Board 04 (A, the owner 2026-11-15): while the note is written and the replacement runs, the session page's top bar says
     * "Handing over" in its middle (iOS `handingOverCapsule`), as the web and Mac headers do (board 02-2), and the composer says it too.
     * In any other state the bar is as before: no badge, and never a run word or a second line. The page as a phone draws it is a PNG
     * under app/build/evidence/handing-over (not committed). */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theSessionBarSaysHandingOverOnlyWhileTheHandoffLocksTheComposer() {
        for (state in listOf("WRITING", "HANDING_OVER", "FAILED", "CANCELLED", null)) {
            if (state == null) coordinatorSession(*running) else coordinatorSession(handoff(state), *running)
            if (state == "WRITING") { signIn(); open("orbit-session:${ComposerShell.SESSION}") } else app().realtime.refreshSession()
            val locks = state == "WRITING" || state == "HANDING_OVER"
            await { if (locks) has(hasTestTag("handoff-progress")) else has(hasTestTag("composer-input") and isEnabled()) }
            val inBar = { text: String -> has(hasText(text) and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true) }
            assertEquals("$state: the bar's Handing over", locks, inBar(CoordinatorHandoffCopy.BADGE_HANDING_OVER))
            assertEquals("$state: in its capsule", locks,
                has(hasTestTag("handing-over-capsule") and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true))
            assertFalse("$state: the bar draws no run word", inBar("Running"))
            assertFalse("$state: the bar has no second line", has(hasTestTag("page-bar-subtitle"), unmerged = true))
            val composerSays = has(hasText(CoordinatorHandoffCopy.HANDING_OVER), unmerged = true)
            assertEquals("$state: the composer says it is handing over", locks, composerSays)
            if (locks) shot(state!!.lowercase())
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
            "note":"Handing over after Friday's release.\nWhere things stand\n- 4 of 6 tasks done; Fix login redirect in review.\nRulings not yet recorded\n- Don't merge Payment retries before Friday's release.\nWaiting on\n- Evidence for Fix login redirect.\nNext\n- Ask for the merge once that evidence is in.",
            "handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[{"id":"w1","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},
            {"id":"w2","label":"Session \"Payment retries\" finishing its turn","paused":true}]}"""))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-note-card")) }
        for (title in CoordinatorHandoff.SECTIONS) assertTrue(title, has(hasText(title), unmerged = true))
        assertTrue(has(hasText("•  4 of 6 tasks done; Fix login redirect in review."), unmerged = true))
        assertTrue("the line before the first heading is kept", has(hasTestTag("handoff-note-preamble") and hasText("Handing over after Friday's release."), unmerged = true))
        assertTrue(has(hasText("the previous coordinator", substring = true), unmerged = true))
        assertTrue(has(hasText("2 waits moved here"), unmerged = true))
        press(hasTestTag("handoff-waits-moved"))
        await { has(hasText("•  Waiting for \"Fix login redirect\" to be DONE"), unmerged = true) }
        assertTrue(has(hasText("•  Session \"Payment retries\" finishing its turn (paused)"), unmerged = true))
        press(hasTestTag("handoff-note-from"))
        await { ComposerShell.calls.any { it.startsWith("GET sessions/34HandoffPrevious00001") } }
    }

    @Test fun theSuccessorsMovedListNamesEachWaitsKind() {
        ComposerShell.session = mapOf("coordinatorHandoffReceived" to Json.parseToJsonElement("""{"handoffFromSessionId":"34HandoffPrevious00001",
            "note":null,"handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[
            {"id":"r1","kind":"SUBAGENT","label":"Deploy 55a189aa3 to production","paused":false},
            {"id":"sw1","kind":"WAKEUP","label":"Check the deploy","paused":false},
            {"id":"w1","kind":"WATCH","label":"Waiting for \"Fix login redirect\" to be DONE","paused":true}]}"""))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("handoff-note-card")) }
        assertTrue(has(hasText("3 waits moved here"), unmerged = true))
        press(hasTestTag("handoff-waits-moved"))
        await { has(hasText("•  Deploy 55a189aa3 to production · SubAgent"), unmerged = true) }
        assertTrue(has(hasText("•  Check the deploy · Scheduled wakeup"), unmerged = true))
        assertTrue(has(hasText("•  Waiting for \"Fix login redirect\" to be DONE (paused)"), unmerged = true))
    }
}

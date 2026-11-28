package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.compose.ui.test.*
import io.orbitd.android.core.cards.PermissionModeDisplay
import io.orbitd.android.core.protocol.ModeChangeHistory
import io.orbitd.android.core.protocol.PermissionModes
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The board docs/mocks/permission-mode-actual on Android, as the owner picked it (A1, B1, C1), drawn by the production app over
 * [ComposerShell] from payloads a real apiserver on PostgreSQL answered ([CapturedPayloads]): the composer's mode control is the mode
 * the server recorded the engine running in (①), a gap from the mode asked for reads "Default → Auto" beside a spinner while the
 * runner switches Claude back and as the running mode beside an amber dot where it stands, its menu saying why (②, A1); the transcript
 * has a quiet shield line for each change, saying who or what made it (③, B1); before a start, Auto on a model with none stays the pick
 * and says it starts in Default (④, C1). Each state is also drawn at the board's phone size to
 * app/build/evidence/permission-mode-actual (not committed), named for the payload it draws.
 */
@Config(qualifiers = "w393dp-h852dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PermissionModeShellTest : ComposerShellTest() {
    @After fun realClock() { modeClock = Instant::now }

    /** The captured session [name] as the shell's session, on the captured runner [runner]; the conversation's two messages are placed
     * among its mode changes — the question after the claim, the reply after the change at [replyAfter] — as a real one runs. */
    private fun session(name: String, runner: String = "workstation-gpu", replyAfter: Int = 0) {
        ComposerShell.runner = CapturedPayloads.runner(runner)
        ComposerShell.session = CapturedPayloads.session(name)
        val changes = PermissionModes.changes(CapturedPayloads.detail(name))
        val asked = Instant.parse(changes.first().at).plusMillis(300)
        val answered = Instant.parse(changes[replyAfter].at).plusMillis(if (replyAfter == 0) 600 else 300)
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"$asked","payload":{"text":"Run the staging migration check and tell me what fails."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-1","ts":"$answered","payload":{"text":"Ran it against staging: 14 of 14 checks passed."}}"""))
    }

    /** The moment of [name]'s newest change, plus [seconds]: when a client reads the payload. */
    private fun momentOf(name: String, seconds: Long) =
        Instant.parse(PermissionModes.changes(CapturedPayloads.detail(name)).last().at).plusSeconds(seconds)

    private fun mode() = compose.onNodeWithTag("composer-mode")
    private fun openModeMenu() {
        mode().performClick()
        await { has(hasTestTag("composer-toolbar-mode:auto")) }
    }
    private fun item(mode: String) = compose.onNodeWithTag("composer-toolbar-mode:$mode")
    private fun top(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.top

    // ① The control is the mode running.

    @Test fun theControlIsTheModeRunningAndItsMenuTicksTheOneAskedFor() {
        session("running-auto")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        mode().assertContentDescriptionEquals("Permission mode Auto")
        assertFalse(has(hasTestTag("composer-mode-correcting"), unmerged = true) || has(hasTestTag("composer-mode-gap"), unmerged = true))
        await { has(hasText("Started in Auto")) }
        shot("01-running-auto")
        openModeMenu()
        item("auto").assertTextContains("✓", substring = true)
        assertFalse(has(hasTestTag("composer-mode-head")))
        // Auto on Opus 5.5 says nothing under its name.
        assertFalse(has(hasText("Not on", substring = true)))
        shot("02-running-auto-menu")
    }

    /** The control follows the record, not the intent: the owner's pick of Plan is stored, and until the engine takes it the session
     * runs in Auto — the control says Auto, with the gap, and the menu ticks Plan. */
    @Test fun theControlFollowsTheRecordNotTheIntent() {
        session("pick-on-its-way")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Auto. You asked for Plan.")
        item("plan").assertTextContains("✓", substring = true)
        shot("09-pick-on-its-way-menu")
    }

    // ② A1: a gap the runner is closing, and one that stands.

    @Test fun claudeStartingInDefaultReadsDefaultToAutoUntilTheRunnerSwitchesItBack() {
        modeClock = { momentOf("correcting", 5) }
        session("correcting")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default → Auto")) }
        compose.onNodeWithTag("composer-mode-correcting", useUnmergedTree = true).assertExists()
        mode().assertContentDescriptionEquals("Permission mode Default, switching to Auto. Running in Default. Claude started below the " +
            "Auto you asked for; the runner is switching it to Auto now.")
        // Claude's report is the transcript's line until the runner acts: amber, the gap's.
        await { has(hasText("Claude started in Default")) }
        shot("03-correcting")
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Default. Claude started below the Auto you asked for; " +
            "the runner is switching it to Auto now.")
        item("auto").assertTextContains("✓", substring = true)
        shot("03-correcting-menu")
    }

    /** The runner's correction, heard on the session's stream, reads the session again: the control is Auto, and the report and the
     * correction are one line. The two payloads are one session, read before the runner acted and after. */
    @Test fun theRunnersCorrectionIsReadAtOnceAndSaidInOneLine() {
        modeClock = { momentOf("correcting", 5) }
        session("correcting")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default → Auto")) }
        session("corrected")
        val corrected = PermissionModes.changes(CapturedPayloads.detail("corrected")).last().at
        ComposerShell.push("""{"type":"system","seq":3,"turnId":"t-1","ts":"$corrected","payload":{"subtype":"permission_mode_corrected","mode":"auto"}}""")
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        await { has(hasText("Mode set back to Auto by the runner — Claude had started in Default")) }
        assertFalse(has(hasText("Claude started in Default")))
        assertFalse(has(hasTestTag("composer-mode-correcting"), unmerged = true))
        shot("10-corrected")
    }

    /** A report the runner did not act on within the minute stands: the dot, and a pick of Auto asks for it again. */
    @Test fun aGapTheRunnerLeftStandsAndAutoCanBeAskedForAgain() {
        modeClock = { momentOf("correcting", 61) }
        session("correcting")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Default. Claude started below the Auto you asked for. Pick Auto to switch it.")
        item("auto").performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals(JsonPrimitive("auto"), ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config")?.get("permissionMode"))
    }

    @Test fun aModelWithNoAutoIsAGapThatStandsAndTheMenuSaysHowToGetAutoBack() {
        session("no-auto-model")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default")) && has(hasText("Haiku 4.5")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        await { has(hasText("Mode now Default — you picked Haiku 4.5, which has no Auto")) }
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Default. You asked for Auto, but Haiku 4.5 has no Auto. " +
            "Pick a model with Auto to get it back.")
        // ✓ stays on what was asked; Auto is still a pick, saying what it runs as here.
        item("auto").assertTextContains("✓", substring = true).assertTextContains("Not on Haiku 4.5, runs as Default", substring = true)
            .assertIsEnabled()
        shot("04-no-auto-model-menu")
    }

    // ③ B1: every change, and who or what made it, where it happened.

    @Test fun theTranscriptSaysEachChangeAndWhoMadeItWhereItHappened() {
        // The reply comes after the runner's first correction (the payload's third change), as the board draws it.
        session("every-cause", replyAfter = 2)
        signIn(); openSession()
        val said = listOf("Started in Auto", "Mode set back to Auto by the runner — Claude had started in Default",
            "Mode set to Plan by you, on the web", "Mode set to Accept Edits by you, on iOS", "Mode set to Auto by you, on Android",
            "Mode set back to Auto by the runner — Claude had restarted in Default", "Mode set to Default by Orbit",
            "Mode set to Auto by you, on Android", "Mode now Default — you picked Haiku 4.5, which has no Auto")
        // Each line by its change (the owner picked Auto on Android twice, so two lines say the same words).
        val detail = CapturedPayloads.detail("every-cause")
        val lines = PermissionModeDisplay.lines(PermissionModes.changes(detail), PermissionModes.intent(detail), PermissionModes.actual(detail),
            noAutoModel = "Haiku 4.5", runsAsRoot = false, scheduledOnClaude = false)
        assertEquals(said, lines.map { it.text })
        await { lines.all { has(hasTestTag(it.key)) } }
        lines.forEach { compose.onNodeWithTag(it.key).assertTextEquals(it.text) }
        // Claude's reports are said by the corrections that followed them, once each.
        assertFalse(has(hasText("Claude started in Default")) || has(hasText("Claude restarted in Default")))
        // In time order, among the messages: the claim before the question, the first correction before the reply, the rest after it.
        val tops = lines.map { top(it.key) }
        assertEquals(tops.sorted(), tops)
        assertTrue(tops[0] < top("event:1")); assertTrue(top("event:1") < tops[1]); assertTrue(tops[1] < top("event:2"))
        assertTrue(top("event:2") < tops[2])
        shot("05-transcript-lines")
    }

    /** A session with more changes than its detail carries (core's wire/permission-mode/paging, from a real apiserver): with its
     * transcript at the session's start, the reader reads the two pages before the detail's newest, from the oldest it holds, and
     * draws every change once, in the order it was recorded, with who or what made it — though whole batches share a moment. */
    @Test fun aLongSessionReadsItsOlderChangesAndDrawsEachOnceInOrder() {
        val detail = CapturedPayloads.json("paging/session-paging").jsonObject
        val newest = PermissionModes.changes(detail)
        val pages = listOf("paging/session-paging-page-1", "paging/session-paging-page-2")
        var held = ModeChangeHistory().adopt(newest, PermissionModes.changesHasMore(detail))
        val before = mutableListOf<Long>()
        for (page in pages) {
            before += held.changes.first().seq!!
            held = held.withOlder(before.last(), PermissionModes.page(CapturedPayloads.json(page).jsonObject))
        }
        val all = held.changes
        assertEquals(111, all.size)
        ComposerShell.runner = CapturedPayloads.runner("workstation-gpu")
        ComposerShell.session = CapturedPayloads.fields("paging/session-paging")
        ComposerShell.modeChangePages = before.zip(pages).associate { (seq, page) -> "$seq" to CapturedPayloads.text(page) }
        val asked = Instant.parse(all.first().at).minusMillis(300)
        val answered = Instant.parse(all.last().at).plusMillis(300)
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"$asked","payload":{"text":"Toggle the feature flag until the canary settles."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-1","ts":"$answered","payload":{"text":"The canary settled at 25%."}}"""))
        signIn(); openSession()

        val lines = PermissionModeDisplay.lines(all, PermissionModes.intent(detail), PermissionModes.actual(detail), noAutoModel = null,
            runsAsRoot = false, scheduledOnClaude = false)
        assertEquals(1 + 6 + 52, lines.size)
        await { lines.all { has(hasTestTag(it.key)) } }
        // Each once, saying who or what made it.
        lines.forEach { line ->
            assertEquals(line.key, 1, compose.onAllNodesWithTag(line.key).fetchSemanticsNodes().size)
            compose.onNodeWithTag(line.key).assertTextEquals(line.text)
        }
        assertEquals(listOf("Started in Auto", "Mode set to Plan by you, on the web", "Mode set to Auto by you, on iOS",
            "Mode set to Accept Edits by you, on Android", "Mode set to Auto by you, on the web", "Mode set to Plan by you, on iOS",
            "Mode set to Auto by you, on Android"), lines.take(7).map { it.text })
        // In the order they were recorded, after the question that opened the session. Where each is in the whole transcript, not
        // the window: the reader follows the tail, so the oldest lines are above it, where their visible bounds are clipped to 0.
        fun y(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().positionInRoot.y
        val ys = lines.map { y(it.key) }
        assertEquals(ys.sorted(), ys)
        assertEquals("each line below the one before", ys.size, ys.toSet().size)
        assertTrue(y("event:1") < ys.first())
        // Asked for once each, from the oldest held: the detail's oldest, then the first page's.
        assertEquals(before.map { "GET sessions/${ComposerShell.SESSION}/permission-mode-changes?before=$it" },
            ComposerShell.calls.filter { it.startsWith("GET sessions/${ComposerShell.SESSION}/permission-mode-changes") })
        shot("07-older-mode-changes")
        // Scrolled up to where the session started: the lines the pages brought, the claim and the owner's picks.
        compose.onNodeWithTag("event:1").performScrollTo()
        compose.onNodeWithTag(lines[6].key).assertIsDisplayed()
        shot("07b-older-mode-changes-start")
    }

    /** A claim-time substitution says why: Bypass can't run on a root runner, so the claim handed Auto. */
    @Test fun aClaimOnARootRunnerSaysWhyItIsNotBypass() {
        session("root-runner", runner = "root-runner")
        signIn(); openSession()
        await { has(hasText("Started in Auto, not Bypass — Bypass can’t run on a root runner")) }
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        mode().assertContentDescriptionEquals("Permission mode Auto. Running in Auto. You asked for Bypass, which can’t run on a root runner.")
        shot("06-root-runner-claim")
    }

    // ④ C1: before the session starts, on the captured runner's catalogue.

    @Test fun beforeAStartAutoOnAModelWithItSaysNothingMore() {
        ComposerShell.runner = CapturedPayloads.runner("workstation-gpu")
        signIn(); openDraft()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        openModeMenu()
        item("auto").assertTextContains("✓", substring = true)
        assertFalse(has(hasTestTag("composer-mode-head")))
        assertFalse(has(hasText("Not on", substring = true)))
        shot("07-draft-opus-menu")
    }

    @Test fun beforeAStartAutoOnAModelWithNoneStaysThePickAndSaysItStartsInDefault() {
        ComposerShell.runner = CapturedPayloads.runner("workstation-gpu")
        signIn(); openDraft()
        openModelMenu()
        compose.onNode(hasText("Haiku 4.5") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        await { has(hasTestTag("composer-mode") and hasText("Default")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Starts in Default. Haiku 4.5 has no Auto; your pick stays Auto and " +
            "applies on a model that has it.")
        item("auto").assertTextContains("✓", substring = true).assertTextContains("Not on Haiku 4.5, starts in Default", substring = true)
            .assertIsEnabled()
        shot("08-draft-no-auto-model-menu")
    }

    // A correction Claude refused, and the claim's substitution, from contracts/permission-mode-refused.

    private val words = "Cannot set permission mode to auto: auto mode unavailable for this model"

    /** The refused session as the server answered it, on the runner that ran it, with its events as the server paged them. */
    @Test fun aRefusedCorrectionIsAGapThatStandsWithTheCliWordsAndItsLine() {
        ComposerShell.runner = RefusedPayloads.runner("pmcf-runner")
        ComposerShell.session = RefusedPayloads.session("refused.android")
        ComposerShell.events = RefusedPayloads.events("refused.events")
        // Read long after: the gap does not wait out a window, and it does not end with one either.
        modeClock = { Instant.parse(PermissionModes.changes(RefusedPayloads.detail("refused.android")).last().at).plusSeconds(600) }
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        assertFalse(has(hasTestTag("composer-mode-correcting"), unmerged = true))
        await { has(hasText("Claude stays in Default — the runner couldn’t switch it to Auto: $words")) }
        val report = top("permission-mode:${PermissionModes.changes(RefusedPayloads.detail("refused.android"))[1].let { "${it.at}:${it.cause}:${it.toMode}" }}")
        assertTrue("the report goes just before the refusal that answers it", report < top("permission-mode-refused:7"))
        shot("11-refused")
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Default. You asked for Auto, but the runner couldn’t switch " +
            "Claude to it: $words.")
        item("auto").assertTextContains("✓", substring = true)
        shot("11-refused-menu")
    }

    @Test fun theClaimLineIsWordedFromTheServersRequestedModeAndReason() {
        ComposerShell.runner = RefusedPayloads.runner("root-runner")
        ComposerShell.session = RefusedPayloads.session("root-claim.android")
        ComposerShell.events = RefusedPayloads.events("root-claim.events")
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        await { has(hasText("Started in Auto, not Bypass — Bypass can’t run on a root runner")) }
        shot("12-root-claim")
    }

    /** The windows on screen, bottom first: the Activity's, then a menu's over it. */
    private fun windows(): List<View> {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val manager = global.getMethod("getInstance").invoke(null)
        val views = (global.getDeclaredField("mViews").apply { isAccessible = true }.get(manager) as List<*>).filterIsInstance<View>()
        val decor = compose.activity.window.decorView
        return listOf(decor) + views.filter { it !== decor && it.isAttachedToWindow && it.isShown && it.width > 0 }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        windows().forEach { view ->
            val at = (view.layoutParams as? WindowManager.LayoutParams)?.takeIf { view !== decor }
            canvas.save()
            at?.let { canvas.translate(it.x.toFloat(), it.y.toFloat()) }
            view.draw(canvas)
            canvas.restore()
        }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/permission-mode-actual/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        println("shot $name -> $file")
    }
}

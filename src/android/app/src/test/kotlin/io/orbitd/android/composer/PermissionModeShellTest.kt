package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.compose.ui.test.*
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The board docs/mocks/permission-mode-actual on Android, as the owner picked it (A1, B1, C1), drawn by the production app over
 * [ComposerShell]: the composer's mode control is the mode the server recorded the engine running in (①), a gap from the mode asked
 * for reads "Default → Auto" beside a spinner while the runner switches Claude back and as the running mode beside an amber dot where
 * it stands, its menu saying why (②, A1); the transcript has a quiet shield line for each change, saying who or what made it (③, B1);
 * before a start, Auto on a model with none stays the pick and says it starts in Default (④, C1). Each state is also drawn at the
 * board's phone size to app/build/evidence/permission-mode-actual (not committed).
 */
@Config(qualifiers = "w393dp-h852dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PermissionModeShellTest : ComposerShellTest() {
    private val haikuRunner = """{"id":"${ComposerShell.RUNNER}","name":"workstation-gpu","online":true,"status":"ONLINE","version":"0.1.261",
        "runsAsRoot":ROOT,"engines":[{"engine":"claude","installed":true,"auth":"yes"}],
        "modelCatalog":{"claude":[
          {"value":"claude-opus-5-5","label":"Opus 5.5","reasoningLevels":["low","medium","high","max"],"permissionModes":["default","acceptEdits","plan","auto","dontAsk","bypassPermissions"]},
          {"value":"claude-haiku-4-5","label":"Haiku 4.5","reasoningLevels":["low","medium","high"],"permissionModes":["default","acceptEdits","plan","dontAsk","bypassPermissions"]}]}}"""

    private fun runner(root: Boolean = false) { ComposerShell.runner = ComposerShell.obj(haikuRunner.replace("ROOT", "$root")) }

    private fun change(from: String?, to: String, cause: String, at: String, client: String? = null) =
        """{"fromMode":${from?.let { "\"$it\"" } ?: "null"},"toMode":"$to","cause":"$cause","client":${client?.let { "\"$it\"" } ?: "null"},"at":"$at"}"""

    /** The session as the detail says it: the mode asked for, the one running, and how it came to be. */
    private fun session(intent: String, actual: String?, vararg changes: String, model: String = "claude-opus-5-5", effort: String = "max") {
        runner()
        ComposerShell.session = ComposerShell.fields("""{"title":"Staging migration check","permissionMode":"$intent",
            "actualPermissionMode":${actual?.let { "\"$it\"" } ?: "null"},"actualPermissionModeAt":"2026-11-22T09:00:00.000Z",
            "model":"$model","effort":"$effort","permissionModeChanges":[${changes.joinToString()}]}""")
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"2026-11-22T09:00:10.000Z","payload":{"text":"Run the staging migration check and tell me what fails."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-1","ts":"2026-11-22T09:01:00.000Z","payload":{"text":"Ran it against staging: 14 of 14 checks passed."}}"""))
    }

    private fun mode() = compose.onNodeWithTag("composer-mode")
    private fun openModeMenu() {
        mode().performClick()
        await { has(hasTestTag("composer-toolbar-mode:auto")) }
    }
    private fun item(mode: String) = compose.onNodeWithTag("composer-toolbar-mode:$mode")
    private fun top(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.top

    // ① The control is the mode running.

    @Test fun theControlIsTheModeRunningAndItsMenuTicksTheOneAskedFor() {
        session("auto", "auto", change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"))
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        mode().assertContentDescriptionEquals("Permission mode Auto")
        assertFalse(has(hasTestTag("composer-mode-correcting"), unmerged = true) || has(hasTestTag("composer-mode-gap"), unmerged = true))
        shot("01-running-auto")
        openModeMenu()
        item("auto").assertTextContains("✓", substring = true)
        assertFalse(has(hasTestTag("composer-mode-head")))
        // Auto on Opus 5.5 says nothing under its name.
        assertFalse(has(hasText("Not on", substring = true)))
        shot("02-running-auto-menu")
    }

    /** The control follows the engine, not the intent: a session asked for Plan whose engine still runs Auto says Auto. */
    @Test fun theControlFollowsTheRecordNotTheIntent() {
        session("plan", "auto", change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"))
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        openModeMenu()
        compose.onNodeWithTag("composer-mode-head").assertTextEquals("Running in Auto. You asked for Plan.")
        item("plan").assertTextContains("✓", substring = true)
    }

    // ② A1: a gap the runner is closing, and one that stands.

    @Test fun claudeStartingInDefaultReadsDefaultToAutoUntilTheRunnerSwitchesItBack() {
        val now = Instant.now()
        session("auto", "default", change(null, "auto", "CLAIM", now.minusSeconds(8).toString()),
            change("auto", "default", "ENGINE_REPORT", now.minusSeconds(5).toString()))
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
     * correction are one line. */
    @Test fun theRunnersCorrectionIsReadAtOnceAndSaidInOneLine() {
        val now = Instant.now()
        val claim = change(null, "auto", "CLAIM", now.minusSeconds(8).toString())
        val report = change("auto", "default", "ENGINE_REPORT", now.minusSeconds(5).toString())
        session("auto", "default", claim, report)
        signIn(); openSession()
        await { has(hasTestTag("composer-mode") and hasText("Default → Auto")) }
        session("auto", "auto", claim, report, change("default", "auto", "RUNNER_CORRECTION", now.minusSeconds(4).toString()))
        ComposerShell.push("""{"type":"system","seq":3,"turnId":"t-1","ts":"${now.minusSeconds(4)}","payload":{"subtype":"permission_mode_corrected","mode":"auto"}}""")
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        await { has(hasText("Mode set back to Auto by the runner — Claude had started in Default")) }
        assertFalse(has(hasText("Claude started in Default")))
        assertFalse(has(hasTestTag("composer-mode-correcting"), unmerged = true))
    }

    /** A report the runner did not act on within the minute stands: the dot, and a pick of Auto asks for it again. */
    @Test fun aGapTheRunnerLeftStandsAndAutoCanBeAskedForAgain() {
        session("auto", "default", change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"),
            change("auto", "default", "ENGINE_REPORT", "2026-11-22T09:00:02.000Z"))
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
        session("auto", "default", change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"),
            change("auto", "default", "OWNER_PICK", "2026-11-22T09:02:00.000Z", "android"), model = "claude-haiku-4-5", effort = "high")
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
        session("auto", "default",
            change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"),
            change("auto", "default", "ENGINE_REPORT", "2026-11-22T09:00:12.000Z"),
            change("default", "auto", "RUNNER_CORRECTION", "2026-11-22T09:00:13.000Z"),
            change("auto", "plan", "OWNER_PICK", "2026-11-22T09:02:00.000Z", "web"),
            change("plan", "acceptEdits", "OWNER_PICK", "2026-11-22T09:03:00.000Z", "ios"),
            change("acceptEdits", "auto", "OWNER_PICK", "2026-11-22T09:04:00.000Z", "android"),
            change("auto", "default", "ORBIT_CHANGE", "2026-11-22T09:05:00.000Z"),
            change("default", "auto", "RESPAWN", "2026-11-22T09:06:00.000Z"),
            change("auto", "default", "OWNER_PICK", "2026-11-22T09:07:00.000Z", "android"),
            model = "claude-haiku-4-5", effort = "high")
        signIn(); openSession()
        val said = listOf("Started in Auto", "Mode set back to Auto by the runner — Claude had started in Default",
            "Mode set to Plan by you, on the web", "Mode set to Accept Edits by you, on iOS", "Mode set to Auto by you, on Android",
            "Mode set to Default by Orbit", "Claude restarted in Auto", "Mode now Default — you picked Haiku 4.5, which has no Auto")
        await { said.all { has(hasText(it)) } }
        // Claude's report is said by the correction, once.
        assertFalse(has(hasText("Claude started in Default")))
        // In time order, among the messages: the claim before the question, the correction before the reply, the rest after it.
        val tops = said.map { text -> compose.onNode(hasText(text)).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(tops.sorted(), tops)
        assertTrue(tops[0] < top("event:1")); assertTrue(top("event:1") < tops[1]); assertTrue(tops[1] < top("event:2"))
        assertTrue(top("event:2") < tops[2])
        shot("05-transcript-lines")
    }

    /** A claim-time substitution says why: Bypass can't run on a root runner, so the claim handed Auto. */
    @Test fun aClaimOnARootRunnerSaysWhyItIsNotBypass() {
        session("bypassPermissions", "auto", change(null, "auto", "CLAIM", "2026-11-22T09:00:00.000Z"))
        runner(root = true)
        signIn(); openSession()
        await { has(hasText("Started in Auto, not Bypass — Bypass can’t run on a root runner")) }
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        compose.onNodeWithTag("composer-mode-gap", useUnmergedTree = true).assertExists()
        mode().assertContentDescriptionEquals("Permission mode Auto. Running in Auto. You asked for Bypass, which can’t run on a root runner.")
        shot("06-root-runner-claim")
    }

    // ④ C1: before the session starts.

    @Test fun beforeAStartAutoOnAModelWithItSaysNothingMore() {
        runner()
        signIn(); openDraft()
        await { has(hasTestTag("composer-mode") and hasText("Auto")) }
        openModeMenu()
        item("auto").assertTextContains("✓", substring = true)
        assertFalse(has(hasTestTag("composer-mode-head")))
        assertFalse(has(hasText("Not on", substring = true)))
        shot("07-draft-opus-menu")
    }

    @Test fun beforeAStartAutoOnAModelWithNoneStaysThePickAndSaysItStartsInDefault() {
        runner()
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

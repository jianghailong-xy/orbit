package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Evidence kit, not a product test (task 34o9etf0IZ0t5oPbYGDz9): the single-task create card on a phone, drawn by the production
 * Activity over the controlled server (`ComposerShell`). Both cards are marked `acceptsStartAfterCreate`. With Create and start: a
 * task in no project and with no prerequisites, which the server's forecast says needs a manual start. Without it: the card a
 * `startNow` create raises, where the runner wrote a due `runAt` before asking, so the forecast says it starts running within the
 * minute. Each card is pressed, and what reached the decision door is written beside the frames:
 * `src/android/build/evidence/create-and-start-android/<scene>-<theme>.png`, its semantics tree, and `<scene>-<theme>-decision.txt`
 * for the scene whose card was pressed.
 */
abstract class CreateAndStartShots : ComposerShellTest() {
    protected abstract val theme: String
    private val decision = "POST sessions/${ComposerShell.SESSION}/approvals/ct1/decision"
    @Volatile private var decided = false

    /** The card the runner raises before task_create: the body it will send, and the server's forecast counted under [bucket]. */
    private fun approval(bucket: String, runAt: String?) = buildJsonObject {
        put("id", "ct1"); put("sessionId", ComposerShell.SESSION); put("toolName", "orbit_task_create"); put("status", "PENDING")
        put("createdAt", Instant.now().minusSeconds(20).toString())
        putJsonObject("input") {
            put("title", "Rotate the release signing key")
            put("description", "The key the release job signs with expires on 5 November. Generate a new one, store it in the " +
                "release secrets and sign the next build with it.")
            put("acceptanceCriteria", "The next release build is signed with the new key, and its signature verifies.")
            put("completionCriterion", "EVIDENCE_JUDGMENT"); put("listId", "list1"); put("assigneeId", ComposerShell.WORKSPACE)
            runAt?.let { put("runAt", it) }
            // The server's mark that this card's runner acts on the choice: on both cards, so a missing door is the forecast's.
            put("acceptsStartAfterCreate", true)
            putJsonObject("preview") {
                put("taskCount", 1)
                listOf("startingNow", "blocked", "needsManualStart", "notDispatchable", "scheduled", "awaitingProjectStart").forEach {
                    put(it, if (it == bucket) 1 else 0)
                }
                put("internalEdges", 0); put("externalEdges", 0)
                putJsonArray("lists") { addJsonObject { put("id", "list1"); put("title", "Backlog") } }
                putJsonArray("assignees") { addJsonObject { put("id", ComposerShell.WORKSPACE); put("name", "Alpha"); put("hasRunner", true) } }
                putJsonArray("tasks") { addJsonObject {
                    put("title", "Rotate the release signing key"); put("listId", "list1")
                    putJsonArray("dependsOnRefs") {}; putJsonArray("dependsOnTaskIds") {}; put("ref", JsonNull)
                } }
                put("titlesTruncated", 0)
            }
        }
    }

    private fun event(seq: Int, type: String, text: String) = buildJsonObject {
        put("type", type); put("seq", seq); putJsonObject("payload") { put("text", text) }
    }

    /** The conversation: the owner's ask, the agent's reply, and its card pending until the decision door answers ALLOWED. */
    private fun conversation(ask: String, reply: String, card: JsonObject) {
        ComposerShell.session = mapOf("title" to JsonPrimitive("Release signing key"))
        ComposerShell.events = listOf(event(1, "user", ask), event(2, "assistant", reply))
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/approvals"] = {
            ApiResponse(200, (if (decided) "[]" else "[$card]").encodeToByteArray())
        }
        ComposerShell.answers[decision] = {
            decided = true
            ApiResponse(200, buildJsonObject { put("id", "ct1"); put("status", "ALLOWED"); put("decidedAt", Instant.now().toString()) }
                .toString().encodeToByteArray())
        }
    }

    private fun door(verb: String) = hasTestTag("approval:ct1:$verb")
    private fun sent() = ComposerShell.bodies.single { it.first == decision }.second

    @Test fun aTaskThatNeedsAManualStartIsOfferedCreateAndStart() {
        conversation("The release signing key expires next week. File a task to rotate it.",
            "I’ll file it as a task in Backlog.", approval("needsManualStart", null))
        signIn(); openSession()
        await { has(door("CREATE_AND_START")) }
        compose.onNode(door("CHAT")).performScrollTo()
        assertTrue(shows("1 needs a manual start"))
        shot("1-offered")
        compose.onNode(door("CREATE_AND_START")).performScrollTo().performClick()
        await { shows("Allowed · recorded by the server") }
        assertEquals("""{"behavior":"allow","startAfterCreate":true}""", sent())
        record("1-offered", "Create and start")
        shot("2-create-and-start-pressed")
    }

    @Test fun aTaskFiledToStartNowIsOfferedCreateTaskAlone() {
        conversation("The release signing key expires next week. File a task to rotate it, and start it now.",
            "I’ll file it as a task in Backlog and start it now.",
            approval("startingNow", Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()))
        signIn(); openSession()
        await { has(door("CREATE_TASK")) }
        compose.onNode(door("CHAT")).performScrollTo()
        assertTrue(shows("1 starts running within the minute"))
        assertFalse(has(door("CREATE_AND_START")))
        assertFalse(has(hasText("Create and start"), unmerged = true))
        shot("3-not-offered")
        compose.onNode(door("CREATE_TASK")).performScrollTo().performClick()
        await { shows("Allowed · recorded by the server") }
        assertEquals("""{"behavior":"allow"}""", sent())
        record("3-not-offered", "Create task")
        shot("4-create-task-pressed")
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/create-and-start-android").also { it.mkdirs() }
    }

    /** What the press sent, as the controlled server recorded it, beside the scene's frame. */
    private fun record(scene: String, pressed: String) =
        File(output, "$scene-$theme-decision.txt").writeText("pressed “$pressed” -> $decision ${sent()}\n")

    /** The screen as a PNG, never a blank one, with its semantics tree beside it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-$theme-semantics.txt").writeText(compose.onAllNodes(isRoot()).printToString(maxDepth = Int.MAX_VALUE))
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name-$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name-$theme ${bitmap.width}×${bitmap.height}")
        bitmap.recycle()
    }
}

/** Light frames on a phone, at twice the density. */
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CreateAndStartLightShotsTest : CreateAndStartShots() {
    override val theme = "light"
}

/** Dark frames: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp-night-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CreateAndStartDarkShotsTest : CreateAndStartShots() {
    override val theme = "dark"
}

package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The owner's Re-run asks for the owner's reason before anything is sent, and the request carries exactly what was typed; Back sends
 * nothing. A check the platform stopped at its time limit says how long it ran against the limit, and "Change the check or its time
 * limit…" opens the project page, whose How it runs holds the Merge check row. Frames go to
 * `src/android/build/evidence/retry-reason-android/` and, when `ORBIT_SHOTS_UPLOADS` is set, into that directory.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1180dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RetryReasonCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val key = "item:35aItem0000000000000001"
    private val pressed = mutableListOf<Pair<CardVerb, CardInput>>()
    private val opened = mutableListOf<String>()
    private val now = Instant.now()
    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes)).toString()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/retry-reason-android").also { it.mkdirs() }
    }

    /** The background's card: project-branch → main's merge check, stopped at its 4h limit, the owner's. */
    private fun row(timedOut: Boolean = true, promotionId: String? = "35aPromotion000000001", taskId: String? = null) = buildJsonObject {
        put("itemId", "35aItem0000000000000001"); put("kind", "INTEGRATION_CHECK_FAILED")
        put("title", "Merge check failed: project/checkout-v2 → main"); put("detailLine", "npm test timed out")
        put("assignee", "OWNER"); put("assigneeReason", "ESCALATED"); put("waitingSince", ago(300)); put("escalatedAt", ago(60))
        put("taskId", taskId); put("sessionId", JsonNull); put("promotionId", promotionId); put("fuseEpisodeId", JsonNull)
        put("landingSessionId", JsonNull); put("integrationJobId", JsonNull)
        putJsonObject("delivery") { put("state", "DELIVERED"); put("sessionId", "35aCoord0000000000001"); put("at", ago(300)) }
        putJsonArray("actions") { add("ASK_COORDINATOR_AGAIN"); add("RETRY") }
        put("requiredAction", "Re-run the merge check after fixing the slow test.")
        put("question", JsonNull); put("lease", JsonNull)
        putJsonObject("facts") {
            put("task", JsonNull); put("targetRef", "refs/heads/main"); put("targetSha", JsonNull); putJsonArray("files") {}
            put("nothingLanded", true); put("branchUnchanged", false); put("errorCode", JsonNull); put("failure", JsonNull)
            putJsonObject("check") {
                put("name", "MERGE_CHECK"); put("command", "npm test"); put("expectedExitCode", 0)
                if (timedOut) { put("exitCode", JsonNull); put("timedOut", true); put("durationMs", 14_400_000); put("timeoutSeconds", 14_400) }
                else { put("exitCode", 1); put("timedOut", false); put("durationMs", 360_000) }
                put("outputTail", "")
            }
        }
        putJsonObject("chat") { put("sessionId", "35aCoord0000000000001"); put("stage", "WITH_OWNER"); put("refusal", JsonNull) }
        put("coordinatorUnreachable", false)
    }

    private fun show(row: JsonObject) {
        val project = buildJsonObject { put("id", "p1"); put("title", "Checkout v2"); put("exceptionEscalationSeconds", 7200) }
        val card = CardCatalog.project("s1", "p1", mapOf("project" to project,
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp)) {
                    ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = { opened += it }, discuss = {},
                        review = {}, main = "main", projectName = "Checkout v2", escalationSeconds = 7200) { verb, input -> pressed += verb to input }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        System.getenv("ORBIT_SHOTS_UPLOADS")?.takeIf { it.isNotBlank() }?.let { dir ->
            File(dir).mkdirs()
            File(dir, "android-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        bitmap.recycle()
    }

    private fun node(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)

    @Test fun reRunAsksForTheReasonAndSendsExactlyWhatWasTyped() {
        show(row())
        shot("card-timed-out")
        node("$key:RERUN_CHECK").performScrollTo().performClick()
        compose.waitForIdle()
        assertTrue("the press alone sends nothing", pressed.isEmpty())
        node("$key:retry-panel").assertExists()
        compose.onNode(hasText(ExceptionCards.retryReasonQuestion)).assertExists()
        compose.onNode(hasText(ExceptionCards.retryReasonHint)).assertExists()
        assertEquals("empty to start", "", node("$key:retry-reason").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        node("$key:retry-confirm").assertIsNotEnabled()
        shot("rerun-prompt-empty")

        node("$key:retry-reason").performTextInput("The runner was swapping; it has more memory now.")
        compose.waitForIdle()
        node("$key:retry-confirm").assertIsEnabled()
        shot("rerun-prompt-typed")
        node("$key:retry-confirm").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(listOf(CardVerb.RERUN_CHECK), pressed.map { it.first })
        val input = pressed.single().second
        assertEquals("The runner was swapping; it has more memory now.", input.text)

        // And that input becomes exactly this request: the candidate's door, the typed reason.
        val card = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row()) }; putJsonArray("withCoordinator") {} })).single()
        val request = CardRequests.build(card, CardVerb.RERUN_CHECK, input)
        assertEquals(listOf("projects", "p1", "promotions", "35aPromotion000000001", "integration", "retry"), request.path)
        assertEquals("""{"reason":"The runner was swapping; it has more memory now."}""", request.body!!.decodeToString())
    }

    @Test fun backSendsNothing() {
        show(row(promotionId = null, taskId = "35aTask00000000000001"))
        node("$key:RETRY_INTEGRATION").performScrollTo().performClick()
        node("$key:retry-reason").performTextInput("Changed my mind")
        node("$key:retry-back").performScrollTo().performClick()
        compose.waitForIdle()
        node("$key:retry-panel").assertDoesNotExist()
        assertTrue(pressed.isEmpty())
    }

    @Test fun aTimedOutCheckSaysItsRunTimeAgainstTheLimitAndOpensTheProjectsMergeCheck() {
        show(row())
        node("$key:time-limit").assertTextEquals("The check ran 4h of a 4h limit.")
        node("$key:change-check:consequence").assertTextEquals(ExceptionCards.checkTimeLimitConsequence)
        node("$key:change-check").performScrollTo().performClick()
        assertEquals(listOf("orbit-project:p1"), opened)
        assertTrue(pressed.isEmpty())
    }

    @Test fun aCheckThatFailedHasNeitherTheLineNorThePress() {
        show(row(timedOut = false))
        node("$key:time-limit").assertDoesNotExist()
        node("$key:change-check").assertDoesNotExist()
    }
}

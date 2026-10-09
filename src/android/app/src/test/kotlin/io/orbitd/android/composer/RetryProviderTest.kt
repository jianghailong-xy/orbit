package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-8 (iOS 163e67872): a Retry pressed after picking a provider in the composer re-sends on it — the retry door gets the pick
 * and its account (RetryIdentityDto) — and one pressed with nothing picked re-sends where the session is. */
class RetryProviderTest : ComposerShellTest() {
    private fun failedSession() {
        ComposerShell.providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]"""
        ComposerShell.session = mapOf("status" to JsonPrimitive("FAILED"), "runState" to JsonPrimitive("FAILED"), "runStatus" to JsonPrimitive("FAILED"),
            "capabilities" to ComposerShell.obj("""{"canSend":false,"canResume":true,"canComplete":true}"""))
    }
    private fun retryFromTheMenu() {
        compose.onNode(hasText("+") and hasClickAction()).performClick()
        val retry = hasText("Retry last failed message") and hasClickAction() and isEnabled()
        await { has(retry) }
        compose.onNode(retry).performClick()
        await { ComposerShell.calls.any { it == "POST sessions/${ComposerShell.SESSION}/retry-message" } }
    }

    @Test fun aRetryAfterAProviderPickRunsOnThePick() {
        failedSession()
        signIn(); openSession(); openModelMenu()
        compose.onNode(hasText("DeepSeek") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        awaitText("Applies when this session resumes.")
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        retryFromTheMenu()
        assertEquals(buildJsonObject { put("provider", "deepseek") }, ComposerShell.body("POST sessions/${ComposerShell.SESSION}/retry-message"))
    }

    @Test fun aRetryWithNothingPickedGoesWhereTheSessionIs() {
        failedSession()
        signIn(); openSession()
        retryFromTheMenu()
        assertEquals(JsonObject(emptyMap()), ComposerShell.body("POST sessions/${ComposerShell.SESSION}/retry-message") ?: JsonObject(emptyMap()))
    }
}

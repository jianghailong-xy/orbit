package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.management.AccountTranslation
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.translation.TranslationCopy
import androidx.compose.runtime.CompositionLocalProvider
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * An owner request in the owner's language (Settings › Translation, board 04-owner-cards.html): its title, why, options, steps and
 * if-unanswered drawn from `translation` with one "Translated · Show original" foot that flips the whole card; with no translation, or
 * a failed one, the card as the agent wrote it and no foot; and an answer or a decline the server could not translate (422
 * TRANSLATION_FAILED) offered again with Retry and Send as written, which posts `sendAsWritten: true`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class OwnerRequestTranslationTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val id = OwnerRequestFixture.DECISION_ID

    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    /** The owner's Settings › Translation: on, in Japanese, unless a test says otherwise. */
    private var account = AccountTranslation(enabled = true, available = true, language = "ja")

    private fun store(translation: String?): OwnerRequestStore {
        val asked = OwnerRequestFixture.decision()
        fixture.hold(if (translation == null) asked else JsonObject(asked + ("translation" to Json.parseToJsonElement(translation))))
        val store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN)
        compose.waitUntil(10_000) { store.state.value.open.size == 1 }
        return store
    }

    private fun show(translation: String?) {
        val store = store(translation)
        compose.setContent { OrbitTheme(darkTheme = false) {
            CompositionLocalProvider(LocalTranslation provides account) {
                val state by store.state.collectAsState()
                Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                    state.open.forEach { OwnerRequestCard(it, store, { "mac-mini" }, {}) }
                }
            }
        } }
        compose.waitForIdle()
    }

    private fun tag(part: String) = compose.onNodeWithTag("owner-request:$id:$part", useUnmergedTree = true)
    private fun has(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun bodies(door: String) = fixture.posts().filter { it.path == "/api/owner-requests/$id/$door" }.map { Json.parseToJsonElement(it.body).jsonObject }

    private val japanese = """{"lang":"ja","title":"ステージングはどのリージョンで動かす？","why":"決済プロバイダーまでの遅延はリージョンで違う。",
        "ifUnanswered":"セッションはタスクを止めたまま明日また聞く。","options":[{"label":"シンガポール","description":"利用者の多くに最も近い"},{"label":"香港"}]}"""

    @Test fun theCardIsDrawnTranslatedAndFlipsWholeToTheOriginal() {
        show(japanese)
        tag("title").assertTextEquals("ステージングはどのリージョンで動かす？")
        assertTrue(has("決済プロバイダーまでの遅延はリージョンで違う。"))
        assertTrue("options are translated, index for index", has("シンガポール") && has("利用者の多くに最も近い") && has("香港"))
        assertFalse(has("Singapore"))
        assertTrue(has(TranslationCopy.TRANSLATED))
        compose.onNodeWithText(TranslationCopy.SHOW_ORIGINAL, useUnmergedTree = true).performClick()
        compose.waitForIdle()
        tag("title").assertTextEquals("Which region should staging run in?")
        assertTrue(has("Latency to the payment provider differs by region.") && has("Singapore") && has("Closest to most users"))
        assertFalse(has("シンガポール"))
        assertTrue(has(TranslationCopy.ORIGINAL) && has(TranslationCopy.SHOW_TRANSLATION))
        compose.onNodeWithText(TranslationCopy.SHOW_TRANSLATION, useUnmergedTree = true).performClick()
        compose.waitForIdle()
        tag("title").assertTextEquals("ステージングはどのリージョンで動かす？")
    }

    @Test fun aTranslationInAnotherLanguageThanTheOwnersIsDrawnAsTheOriginal() {
        account = AccountTranslation(enabled = true, available = true, language = "zh-Hans")
        show(japanese)
        tag("title").assertTextEquals("Which region should staging run in?")
    }

    @Test fun aTranslatedOptionStillAnswersByItsIndex() {
        show(japanese)
        tag("option:1").performClick()
        tag("primary").performClick()
        compose.waitUntil(10_000) { bodies("done").isNotEmpty() }
        assertEquals(buildJsonObject { put("option", 1) }, bodies("done").single())
    }

    @Test fun noTranslationOrAFailedOneDrawsTheOriginalWithNoFoot() {
        show(null)
        tag("title").assertTextEquals("Which region should staging run in?")
        assertFalse(has(TranslationCopy.SHOW_ORIGINAL))
        tag("translation-foot").assertDoesNotExist()
    }

    @Test fun aFailedTranslationDrawsTheOriginalWithNoFoot() {
        show("""{"lang":"ja","failed":true}""")
        tag("title").assertTextEquals("Which region should staging run in?")
        tag("translation-foot").assertDoesNotExist()
    }

    @Test fun anAnswerThatCouldNotBeTranslatedOffersRetryAndSendAsWritten() {
        fixture.refuseUntranslated = true
        show(japanese)
        tag("answer").performTextInput("香港のほうが遅延が少ない")
        tag("primary").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:translation-failed", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(has(TranslationCopy.SEND_FAILED))
        tag("error").assertDoesNotExist()
        // Retry sends it as before, and is refused again.
        compose.onNodeWithText(TranslationCopy.RETRY, useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { bodies("done").size == 2 }
        compose.waitUntil(10_000) { has(TranslationCopy.SEND_FAILED) }
        compose.onNodeWithText(TranslationCopy.SEND_AS_WRITTEN, useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { bodies("done").size == 3 }
        val sent = bodies("done")
        assertNull("the first two go to be translated", sent[0]["sendAsWritten"] ?: sent[1]["sendAsWritten"])
        assertEquals(JsonPrimitive("香港のほうが遅延が少ない"), sent[0]["text"])
        assertEquals(JsonPrimitive(true), sent[2]["sendAsWritten"])
        assertEquals(sent[0]["text"], sent[2]["text"])
        // Sent as written, it was recorded: the request is no longer open, and the card it was has gone from this list.
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun aDeclineThatCouldNotBeTranslatedOffersSendAsWritten() {
        fixture.refuseUntranslated = true
        show(japanese)
        tag("decline").performClick()
        tag("reason").performTextInput("まだ決められない")
        tag("decline-send").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:translation-failed", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(TranslationCopy.SEND_AS_WRITTEN, useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { bodies("decline").size == 2 }
        assertEquals(buildJsonObject { put("reason", "まだ決められない"); put("sendAsWritten", true) }, bodies("decline")[1])
    }
}

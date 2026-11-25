package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.objects
import io.orbitd.android.management.AccountTranslation
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.translation.TranslationCopy
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.time.Instant

/**
 * A project's title and criteria in the owner's language (ProjectTextTranslation) on the production composables that draw them: "Is
 * this project done?" as the owner opens it and as the coordinator asks it, its receipt, and the project page's criteria list. Each
 * draws the translation with one "Translated · Show original" foot that flips it whole, and the project's own words with no foot
 * while there is no translation to draw. The document is core's `project-get.json`, a response the apiserver served.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h2000dp")
class ProjectTextTranslationViewsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    private val doc = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .map { File(it, "src/android/core/src/test/resources/project-get.json") }.first { it.isFile }.let { j(it.readText()) }
    private val translatedWords = listOf("ZH[The release is on main]", "ZH[The live check was completed]")
    private val originalWords = listOf("The release is on main", "The live check was completed")
    private val on = AccountTranslation(enabled = true, available = true, language = "zh-Hans")

    private fun show(account: AccountTranslation = on, content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            CompositionLocalProvider(LocalTranslation provides account) { Surface { content() } }
        } } }
        compose.waitForIdle()
    }
    private fun card(document: JsonObject = doc, request: JsonObject? = null, record: JsonObject? = null, account: AccountTranslation = on) = show(account) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
            ProjectDoneCard(document, request, null, 0, 0, record, true, Instant.parse("2026-11-25T02:00:00.000Z"), enabled = true, error = null,
                tag = "done", onRecord = {}, onNotYet = { _, _ -> true }, onReopen = {})
        }
    }
    private fun page(document: JsonObject = doc, account: AccountTranslation = on) = show(account) {
        LazyColumn { criteriaSection(document, openTask = {}, actions = null, now = Instant.parse("2026-11-25T02:00:00.000Z")) }
    }
    private fun count(text: String) = compose.onAllNodesWithText(text, substring = false, useUnmergedTree = true).fetchSemanticsNodes().size
    private fun has(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun press(text: String) { compose.onNodeWithText(text, useUnmergedTree = true).performClick(); compose.waitForIdle() }
    private fun noFoot() = compose.onAllNodesWithTag("translation-foot", useUnmergedTree = true).assertCountEquals(0)

    /** One foot; the translated words, then flipped whole to the original and back. */
    private fun flips(translated: List<String>, original: List<String>) {
        compose.onAllNodesWithTag("translation-foot", useUnmergedTree = true).assertCountEquals(1)
        translated.forEach { assertTrue("shows $it", has(it)) }
        original.forEach { assertEquals("hides $it", 0, count(it)) }
        press(TranslationCopy.SHOW_ORIGINAL)
        original.forEach { assertTrue("shows $it", has(it)) }
        translated.forEach { assertFalse("hides $it", has(it)) }
        assertTrue(has(TranslationCopy.ORIGINAL))
        press(TranslationCopy.SHOW_TRANSLATION)
        translated.forEach { assertTrue("shows $it again", has(it)) }
    }

    private val asked = j("""{"itemId":"req1","kind":"DONE_REQUEST","waitingSince":"2026-11-25T01:00:00.000Z",
        "doneRequest":{"criteriaDigest":"d","judgment":"The goal is met.","gaps":[]},
        "translation":{"lang":"zh-Hans","judgment":"目标达成。"}}""")

    @Test fun theOwnersOwnDoneCardIsDrawnTranslatedAndFlipsWhole() {
        card()
        flips(translatedWords + ProjectDone.meta("ZH[Project closeout]", false, null), originalWords + ProjectDone.meta("Project closeout", false, null))
    }

    @Test fun theRequestedDoneCardFlipsTheProjectsWordsWithTheCoordinatorsByOneFoot() {
        card(request = asked)
        flips(translatedWords + "目标达成。" + ProjectDone.meta("ZH[Project closeout]", true, "waiting 1h"),
            originalWords + "The goal is met." + ProjectDone.meta("Project closeout", true, "waiting 1h"))
    }

    /** A gap with no title of its own is named by its criterion's words. */
    @Test fun aGapNamedByItsCriterionReadsItTranslated() {
        val key = doc.objects("acceptanceCriteriaItems")[0].getValue("id").jsonPrimitive.content
        card(request = j("""{"itemId":"req1","kind":"DONE_REQUEST","doneRequest":{"judgment":"J","gaps":[{"criterionKey":"$key"}]}}"""))
        compose.onNodeWithTag("done-gap:$key").assert(hasAnyDescendant(hasText("ZH[The release is on main]")) or hasText("ZH[The release is on main]", substring = true))
    }

    @Test fun theReceiptNamesTheProjectTranslatedAndFlips() {
        val record = j("""{"status":"DONE","doneBy":"OWNER","doneAt":"2026-11-25T01:40:00.000Z","acceptedGaps":[]}""")
        card(record = record)
        compose.onNodeWithTag("done-receipt-meta").assertTextContains("ZH[Project closeout]", substring = true)
        press(TranslationCopy.SHOW_ORIGINAL)
        compose.onNodeWithTag("done-receipt-meta").assertTextContains("Project closeout · ", substring = true)
    }

    @Test fun thePagesCriteriaListIsDrawnTranslatedAndFlipsWhole() {
        page()
        flips(translatedWords, originalWords)
    }

    private fun asWritten(draw: (JsonObject, AccountTranslation) -> Unit) {
        val failed = JsonObject(doc + ("translation" to j("""{"lang":"zh-Hans","failed":true}""")))
        listOf("no translation" to (JsonObject(doc - "translation") to on), "failed" to (failed to on),
            "another language" to (doc to on.copy(language = "ja")), "translation off" to (doc to on.copy(enabled = false))).forEach { (case, input) ->
            draw(input.first, input.second)
            originalWords.forEach { assertTrue("$case shows $it", has(it)) }
            assertFalse("$case draws no translated words", has("ZH["))
            noFoot()
        }
    }

    @Test fun theDoneCardFallsBackToTheProjectsOwnWords() = asWritten { document, account -> card(document, account = account) }

    @Test fun theCriteriaListFallsBackToTheProjectsOwnWords() = asWritten { document, account -> page(document, account) }
}

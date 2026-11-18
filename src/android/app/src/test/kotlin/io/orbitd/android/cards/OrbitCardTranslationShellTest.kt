package io.orbitd.android.cards

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.translation.TranslationCopy
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Orbit's own create, batch, project, blocker and DAG-change cards in a conversation, over the controlled server, once the server
 * translated them (ApprovalTranslation): the card draws the owner's language with one "Translated · Show original" foot, whose press
 * draws the whole card as the agent wrote it ("Original · Show translation"). A card with no translation, or a failed one, draws the
 * original and no foot.
 */
class OrbitCardTranslationShellTest : ComposerShellTest() {
    private fun serve(tool: String, input: String, translation: String?) {
        val approval = """{"id":"oc1","sessionId":"${ComposerShell.SESSION}","toolName":"$tool","status":"PENDING",""" +
            """"createdAt":"2026-11-18T01:00:00.000Z","input":$input""" + (translation?.let { ""","translation":$it}""" } ?: "}")
        Json.parseToJsonElement(approval) // a fixture that is not JSON fails here, not as a card that never shows
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/approvals"] = { ApiResponse(200, "[$approval]".encodeToByteArray()) }
    }
    private fun text(value: String) = hasText(value, substring = true)
    private fun showsText(value: String) = has(text(value))

    /** The card in the conversation, opened into its review where the conversation draws it as a compact preview (batch, blocker,
     * DAG change). */
    private fun openCard() {
        signIn(); openSession()
        await { has(hasTestTag("approval:oc1")) }
        if (has(hasTestTag("approval:oc1:preview"))) {
            compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("approval:oc1:preview"))
            compose.onNodeWithTag("approval:oc1:preview").performClick()
        }
    }

    /** The card drawn translated with its foot, then flipped to the original and back. */
    private fun translatedThenOriginal(translated: String, original: String) {
        openCard()
        await { showsText(translated) }
        assertFalse(showsText(original))
        assertTrue(shows(TranslationCopy.TRANSLATED))
        compose.onNodeWithText(TranslationCopy.SHOW_ORIGINAL).performScrollTo().performClick()
        await { showsText(original) }
        assertFalse(showsText(translated))
        assertTrue(shows(TranslationCopy.ORIGINAL))
        assertFalse(shows(TranslationCopy.SHOW_ORIGINAL))
        compose.onNodeWithText(TranslationCopy.SHOW_TRANSLATION).performScrollTo().performClick()
        await { showsText(translated) }
    }

    private val taskCreate = """{"title":"Rotate the signing key","description":"Replace the key.","acceptanceCriteria":"The release signs with the new key.","completionCriterion":"EVIDENCE_JUDGMENT"}"""

    @Test fun aTaskCreateCardIsDrawnTranslatedAndFlipsToTheOriginal() {
        serve("orbit_task_create", taskCreate,
            """{"lang":"ja","title":"署名鍵を更新する","description":"鍵を置き換える。","acceptanceCriteria":"新しい鍵で署名される。"}""")
        translatedThenOriginal("署名鍵を更新する", "Rotate the signing key")
        assertTrue(showsText("新しい鍵で署名される。"))
    }

    @Test fun aProjectCreateCardIsDrawnTranslatedAndFlipsToTheOriginal() {
        serve("orbit_project_create", """{"title":"Faster builds","goal":"Halve the build time.","acceptanceCriteriaItems":[{"text":"Builds take under 5 minutes."}]}""",
            """{"lang":"ja","title":"速いビルド","goal":"ビルド時間を半分にする。","acceptanceCriteriaItems":[{"text":"ビルドは5分未満。"}]}""")
        translatedThenOriginal("ビルドは5分未満。", "Builds take under 5 minutes.")
        assertTrue(showsText("速いビルド"))
    }

    @Test fun aBatchCardIsDrawnTranslatedAndFlipsToTheOriginal() {
        serve("orbit_task_batch", """{"tasks":[{"title":"Write the parser"},{"title":"Wire it in"}],
            "preview":{"taskCount":2,"startingNow":2,"tasks":[{"ref":"a","title":"Write the parser"},{"ref":"b","title":"Wire it in"}]}}""",
            """{"lang":"ja","tasks":[{"title":"パーサーを書く"},{"title":"組み込む"}]}""")
        translatedThenOriginal("パーサーを書く", "Write the parser")
        assertTrue("every task title is translated", showsText("組み込む"))
    }

    @Test fun aBlockerCardIsDrawnTranslatedAndFlipsToTheOriginal() {
        serve("orbit_blocker_resolve", """{"projectTitle":"Faster builds","reason":"The cache is fixed now.","blocker":{"kind":"DEPENDENCY","requiredAction":"Fix the cache"}}""",
            """{"lang":"ja","reason":"キャッシュはもう直った。"}""")
        translatedThenOriginal("キャッシュはもう直った。", "The cache is fixed now.")
    }

    @Test fun aDagChangeCardIsDrawnTranslatedAndFlipsToTheOriginal() {
        serve("orbit_dag_change", """{"note":"The parser must land first.","preview":{"listTitle":"Backlog","edgesBefore":1,"edgesAfter":2,"ops":[]}}""",
            """{"lang":"ja","note":"パーサーが先に入る必要がある。"}""")
        translatedThenOriginal("パーサーが先に入る必要がある。", "The parser must land first.")
    }

    @Test fun aCardWithoutATranslationIsDrawnAsItCameWithNoFoot() {
        serve("orbit_task_create", taskCreate, null)
        openCard()
        await { showsText("Rotate the signing key") }
        assertFalse(shows(TranslationCopy.SHOW_ORIGINAL))
        assertFalse(has(hasTestTag("translation-foot"), unmerged = true))
    }

    @Test fun aCardWhoseTranslationFailedIsDrawnAsItCameWithNoFoot() {
        serve("orbit_blocker_resolve", """{"projectTitle":"Faster builds","reason":"The cache is fixed now.","blocker":{"kind":"DEPENDENCY"}}""",
            """{"lang":"ja","failed":true}""")
        openCard()
        await { showsText("The cache is fixed now.") }
        assertFalse(shows(TranslationCopy.SHOW_ORIGINAL))
        assertFalse(has(hasTestTag("translation-foot"), unmerged = true))
    }
}

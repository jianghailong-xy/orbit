package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.SessionSnapshot
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Orbit's own create, batch, project, blocker and DAG-change cards in the owner's language (ApprovalTranslation's title,
 * acceptanceCriteria, tasks, goal, acceptanceCriteriaItems, reason and note): drawn translated, flipped back whole by "Show original",
 * and drawn as they came with no translation, a failed one, or one that changes nothing the card draws. */
class OrbitCardTranslationTest {
    private fun obj(json: String) = Wire.json.parseToJsonElement(json).jsonObject

    private fun card(approval: JsonObject): InteractionCard =
        CardCatalog.session("s1", SessionSnapshot(obj("""{"id":"s1"}"""), listOf(approval), emptyList(), emptyList(), emptyMap())).single()

    private fun approval(tool: String, input: String, translation: String?) = obj(
        """{"id":"ap1","sessionId":"s1","toolName":"$tool","status":"PENDING","input":$input""" +
            (translation?.let { ""","translation":$it}""" } ?: "}"))

    private fun JsonObject.at(vararg path: Any): String? {
        var at: JsonElement? = this
        path.forEach { key -> at = when (key) { is Int -> (at as? JsonArray)?.getOrNull(key); else -> (at as? JsonObject)?.get(key as String) } }
        return (at as? JsonPrimitive)?.contentOrNull
    }

    private fun input(card: InteractionCard, showOriginal: Boolean) = OrbitCardTranslation.shown(card, showOriginal).source.obj("input")!!

    /** The card translated, then flipped to the original; with no translation and with a failed one, the original and no foot. */
    private fun check(tool: String, input: String, translation: String, expect: (JsonObject, Boolean) -> Unit) {
        val translated = card(approval(tool, input, translation))
        assertTrue("$tool has the foot", OrbitCardTranslation.translated(translated))
        expect(input(translated, false), true)
        expect(input(translated, true), false)
        assertEquals("the binding is the engine's own input", obj(input).toString(), translated.binding)
        val none = card(approval(tool, input, null))
        assertFalse(OrbitCardTranslation.translated(none))
        expect(input(none, false), false)
        val failed = card(approval(tool, input, """{"lang":"ja","failed":true}"""))
        assertFalse(OrbitCardTranslation.translated(failed))
        expect(input(failed, false), false)
    }

    @Test fun aTaskCreateCardShowsItsTitleDescriptionAndCriteriaTranslated() = check("orbit_task_create",
        """{"title":"Rotate the key","description":"Replace the signing key.","acceptanceCriteria":"The release signs with the new key.","completionCriterion":"EVIDENCE_JUDGMENT"}""",
        """{"lang":"ja","title":"鍵を更新する","description":"署名鍵を置き換える。","acceptanceCriteria":"新しい鍵で署名される。"}""") { shown, translated ->
        assertEquals(if (translated) "鍵を更新する" else "Rotate the key", shown.at("title"))
        assertEquals(if (translated) "署名鍵を置き換える。" else "Replace the signing key.", shown.at("description"))
        assertEquals(if (translated) "新しい鍵で署名される。" else "The release signs with the new key.", shown.at("acceptanceCriteria"))
        assertEquals("EVIDENCE_JUDGMENT", shown.at("completionCriterion"))
    }

    @Test fun aProjectCreateCardShowsItsTitleGoalAndCriteriaItemsTranslated() = check("orbit_project_create",
        """{"title":"Faster builds","goal":"Halve the build time.","instructions":"Measure first.",
           "acceptanceCriteriaItems":[{"text":"Builds take under 5 minutes.","verificationMethod":"Time three builds."},{"text":"No test is skipped."}]}""",
        """{"lang":"ja","title":"速いビルド","goal":"ビルド時間を半分にする。","instructions":"まず測る。",
           "acceptanceCriteriaItems":[{"text":"ビルドは5分未満。","verificationMethod":"3回計る。"},{"text":"テストを飛ばさない。"}]}""") { shown, translated ->
        assertEquals(if (translated) "速いビルド" else "Faster builds", shown.at("title"))
        assertEquals(if (translated) "ビルド時間を半分にする。" else "Halve the build time.", shown.at("goal"))
        assertEquals(if (translated) "ビルドは5分未満。" else "Builds take under 5 minutes.", shown.at("acceptanceCriteriaItems", 0, "text"))
        assertEquals(if (translated) "3回計る。" else "Time three builds.", shown.at("acceptanceCriteriaItems", 0, "verificationMethod"))
        assertEquals(if (translated) "テストを飛ばさない。" else "No test is skipped.", shown.at("acceptanceCriteriaItems", 1, "text"))
        assertNull("a field the original lacks stays absent", shown.at("acceptanceCriteriaItems", 1, "verificationMethod"))
        assertEquals("Android does not draw the instructions", "Measure first.", shown.at("instructions"))
    }

    @Test fun aBatchCardShowsEachTaskTranslatedIndexForIndex() = check("orbit_task_batch",
        """{"tasks":[{"title":"Write the parser","description":"Parse the file.","acceptanceCriteria":"It parses."},{"title":"Wire it in"}],
           "preview":{"taskCount":2,"tasks":[{"ref":"a","title":"Write the parser"},{"ref":"b","title":"Wire it in","dependsOnRefs":["a"]}]}}""",
        """{"lang":"ja","tasks":[{"title":"パーサーを書く","description":"ファイルを解析する。","acceptanceCriteria":"解析できる。"},{"title":"組み込む"}]}""") { shown, translated ->
        assertEquals(if (translated) "パーサーを書く" else "Write the parser", shown.at("preview", "tasks", 0, "title"))
        assertEquals(if (translated) "組み込む" else "Wire it in", shown.at("preview", "tasks", 1, "title"))
        assertEquals(if (translated) "パーサーを書く" else "Write the parser", shown.at("tasks", 0, "title"))
        assertEquals(if (translated) "ファイルを解析する。" else "Parse the file.", shown.at("tasks", 0, "description"))
        assertEquals(if (translated) "解析できる。" else "It parses.", shown.at("tasks", 0, "acceptanceCriteria"))
        assertEquals("b", shown.at("preview", "tasks", 1, "ref"))
        assertEquals(listOf(if (translated) "パーサーを書く" else "Write the parser", if (translated) "組み込む" else "Wire it in"),
            BatchReview.tasks(shown.obj("preview")).map { it.title })
    }

    @Test fun aBlockerCardShowsItsReasonTranslated() = check("orbit_blocker_resolve",
        """{"projectTitle":"Faster builds","reason":"The cache is fixed.","blocker":{"kind":"DEPENDENCY","requiredAction":"Fix the cache"}}""",
        """{"lang":"ja","reason":"キャッシュは直った。"}""") { shown, translated ->
        assertEquals(if (translated) "キャッシュは直った。" else "The cache is fixed.", shown.at("reason"))
        assertEquals("Fix the cache", shown.at("blocker", "requiredAction"))
    }

    @Test fun aDagChangeCardShowsItsNoteTranslated() = check("orbit_dag_change",
        """{"note":"The parser must land first.","preview":{"listTitle":"Backlog","edgesBefore":1,"edgesAfter":2,"ops":[]}}""",
        """{"lang":"ja","note":"パーサーが先に入る必要がある。"}""") { shown, translated ->
        assertEquals(if (translated) "パーサーが先に入る必要がある。" else "The parser must land first.", shown.at("note"))
        assertEquals("Backlog", shown.at("preview", "listTitle"))
    }

    @Test fun aTranslationOfNothingTheCardDrawsHasNoFoot() {
        // Only the instructions (not drawn) and a field the original lacks: nothing the card shows changes.
        val card = card(approval("orbit_project_create", """{"title":"Faster builds"}""", """{"lang":"ja","instructions":"まず測る。","goal":"ビルド時間を半分にする。"}"""))
        assertFalse(OrbitCardTranslation.translated(card))
        assertNull(card.source.obj("input")!!.at("goal"))
        assertEquals("Faster builds", card.source.obj("input")!!.at("title"))
    }

    @Test fun anotherToolsTitleIsNeverTranslated() {
        val card = card(approval("Bash", """{"command":"ls","title":"List"}""", """{"lang":"ja","title":"一覧"}"""))
        assertFalse(OrbitCardTranslation.translated(card))
        assertEquals("List", card.source.obj("input")!!.at("title"))
    }
}

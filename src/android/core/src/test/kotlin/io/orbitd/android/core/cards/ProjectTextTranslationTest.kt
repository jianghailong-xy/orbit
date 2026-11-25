package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A project's title and criteria in the owner's language (`translation` on `GET /projects/:id`, ProjectTextTranslation in
 * src/shared/src/translation.ts). `project-get.json` is a response the apiserver served, with its translator stubbed to answer
 * `ZH[words]`.
 */
class ProjectTextTranslationTest {
    private val doc = Json.parseToJsonElement(javaClass.getResource("/project-get.json")!!.readText()).jsonObject
    private fun texts(doc: JsonObject) = doc.objects("acceptanceCriteriaItems").map { it.text("text") }
    private fun translated(translation: String) = JsonObject(doc + ("translation" to Json.parseToJsonElement(translation)))

    @Test fun theServedPayloadDrawsItsTitleAndCriteriaInTheOwnersLanguage() {
        val shown = OwnerCardTranslation.project(doc, "zh-Hans")!!
        assertEquals("ZH[Project closeout]", shown.text("title"))
        assertEquals(listOf("ZH[The release is on main]", "ZH[The live check was completed]"), texts(shown))
        assertEquals("only the words change", doc.objects("acceptanceCriteriaItems").map { JsonObject(it - "text") },
            shown.objects("acceptanceCriteriaItems").map { JsonObject(it - "text") })
        assertEquals(JsonObject(doc - "title" - "acceptanceCriteriaItems"), JsonObject(shown - "title" - "acceptanceCriteriaItems"))
    }

    @Test fun theServedPayloadIsDrawnAsWrittenWithTranslationOffOrInAnotherLanguage() {
        assertNull("translation off", OwnerCardTranslation.project(doc, null))
        assertNull("another language than the owner's", OwnerCardTranslation.project(doc, "ja"))
    }

    @Test fun noTranslationAFailedOneOrOneThatChangesNothingIsNone() {
        assertNull(OwnerCardTranslation.project(JsonObject(doc - "translation"), "zh-Hans"))
        assertNull(OwnerCardTranslation.project(translated("""{"lang":"zh-Hans","failed":true}"""), "zh-Hans"))
        assertNull(OwnerCardTranslation.project(translated("""{"lang":"zh-Hans"}"""), "zh-Hans"))
    }

    @Test fun aCriterionIsMatchedByItsIdAndOneWithoutATranslationStaysAsWritten() {
        val second = doc.objects("acceptanceCriteriaItems")[1].text("id")
        val shown = OwnerCardTranslation.project(translated("""{"lang":"zh-Hans","criteria":[{"id":"$second","text":"二"},{"id":"gone","text":"三"}]}"""), "zh-Hans")!!
        assertEquals(listOf("The release is on main", "二"), texts(shown))
        assertEquals("Project closeout", shown.text("title"))
    }
}

package io.orbitd.android.core.translation

import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.CardInput
import io.orbitd.android.core.cards.CardRequests
import io.orbitd.android.core.cards.CardVerb
import io.orbitd.android.core.cards.approvalQuestions
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.realtime.Transcript
import io.orbitd.android.core.realtime.EventPage
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Settings › Translation's wire shapes (src/shared/src/translation.ts) as Android reads them: the preferences, a turn's and a
 * reply's `translation`, the live `translation` event folded into the event it translates, a translated suggestion, and an approval
 * card shown — and answered — in the owner's language. */
class TranslationTest {
    private fun obj(json: String) = Wire.json.parseToJsonElement(json).jsonObject

    @Test fun theSevenLanguagesAndTheirTagsAreTheSharedOnes() {
        val shared = java.io.File(generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/translation.ts").isFile }, "src/shared/src/translation.ts").readText()
        assertEquals(listOf("zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de"), Translation.LANGUAGES.map { it.first })
        assertTrue(shared.contains("TRANSLATION_LANGUAGES = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de'] as const"))
        Translation.LANGUAGES.forEach { (code, name) ->
            val key = if (code.contains('-')) "'$code'" else code
            assertTrue("$code → $name is not shared's", shared.contains("$key: '$name',"))
        }
        assertTrue(shared.contains("DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = '${Translation.DEFAULT_LANGUAGE}'"))
        assertTrue(shared.contains("TRANSLATION_FAILED_CODE = '${Translation.FAILED_CODE}'"))
        assertEquals("Chinese → English", Translation.tag("zh-Hans"))
        assertEquals("Chinese → English", Translation.tag("zh-Hant"))
        assertEquals("Japanese → English", Translation.tag("ja"))
        assertEquals("German → English", Translation.tag("de"))
    }

    @Test fun preferencesReadOffUnlessSwitchedOnAndTheDefaultLanguageWhenAbsent() {
        assertFalse(Translation.enabled(null))
        assertFalse(Translation.enabled(obj("""{}""")))
        assertFalse(Translation.enabled(obj("""{"translationEnabled":"true"}""")))
        assertTrue(Translation.enabled(obj("""{"translationEnabled":true}""")))
        assertEquals("zh-Hans", Translation.language(obj("""{}""")))
        assertEquals("zh-Hans", Translation.language(obj("""{"translationLanguage":"xx"}""")))
        assertEquals("ja", Translation.language(obj("""{"translationLanguage":"ja"}""")))
        assertFalse("an older server says nothing: unable", Translation.available(obj("""{"id":"u1"}""")))
        assertFalse(Translation.available(obj("""{"translationAvailable":false}""")))
        assertTrue(Translation.available(obj("""{"translationAvailable":true}""")))
    }

    @Test fun aTurnsTranslationParsesEachStateAndRefusesWhatIsNotOne() {
        val done = Translation.turn(obj("""{"state":"DONE","from":"zh-Hans","original":"修复登录"}"""))!!
        assertEquals(Translation.Turn(Translation.TurnState.DONE, "zh-Hans", "修复登录"), done)
        assertFalse(done.held)
        assertTrue(Translation.turn(obj("""{"state":"TRANSLATING","from":"ja","original":"x"}"""))!!.held)
        assertTrue(Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x"}"""))!!.held)
        assertFalse(Translation.turn(obj("""{"state":"SENT_AS_WRITTEN","from":"ja","original":"x"}"""))!!.held)
        assertNull(Translation.turn(obj("""{"state":"LOST","from":"ja","original":"x"}""")))
        assertNull(Translation.turn(obj("""{"state":"DONE","from":"en","original":"x"}""")))
        assertNull(Translation.turn(obj("""{"state":"DONE","from":"ja"}""")))
        assertNull(Translation.turn(JsonNull))
    }

    @Test fun aRepliesTranslationIsItsTextOrItsFailure() {
        assertEquals(Translation.Reply("zh-Hans", "找到了", false), Translation.reply(obj("""{"lang":"zh-Hans","text":"找到了"}""")))
        assertEquals(Translation.Reply("ko", null, true), Translation.reply(obj("""{"lang":"ko","failed":true}""")))
        assertNull(Translation.reply(obj("""{"lang":"ko"}""")))
        assertNull(Translation.reply(obj("""{"lang":"en","text":"x"}""")))
    }

    @Test fun aLiveTranslationFoldsIntoTheEventItTranslatesAsAReplayCarriesIt() {
        val reply = RunEvent("assistant", 5, obj("""{"text":"Found it."}"""))
        val transcript = Transcript().page(EventPage(listOf(RunEvent("user", 4, obj("""{"text":"Fix it"}""")), reply)))
        val live = RunEvent("translation", 0, obj("""{"of":5,"lang":"zh-Hans","text":"找到了。"}"""))
        assertFalse("live-only", live.durable)
        val folded = transcript.apply(live)
        assertEquals(obj("""{"text":"Found it.","translation":{"lang":"zh-Hans","text":"找到了。"}}"""), folded.events.last().payload)
        assertEquals(transcript.resumeSeq, folded.resumeSeq)
        // A failure replaces it, and a retry's answer replaces that.
        val failed = folded.apply(RunEvent("translation", 0, obj("""{"of":5,"lang":"zh-Hans","failed":true}""")))
        assertEquals(Translation.Reply("zh-Hans", null, true), Translation.reply(failed.events.last().fields["translation"]))
        // One for an event outside the window waits for that event's replay.
        assertSame(transcript, transcript.apply(RunEvent("translation", 0, obj("""{"of":99,"lang":"zh-Hans","text":"x"}"""))))
    }

    @Test fun aTranslatedSuggestionIsOfferedInTheOwnersLanguage() {
        val events = listOf(RunEvent("turn_end", 1, obj("{}")),
            RunEvent("prompt_suggestion", 2, obj("""{"text":"Run the tests","translation":{"lang":"zh-Hans","text":"跑一下测试"}}""")))
        assertEquals("跑一下测试", Transcript().page(EventPage(events)).promptSuggestion)
        val failed = listOf(RunEvent("prompt_suggestion", 3, obj("""{"text":"Run the tests","translation":{"lang":"zh-Hans","failed":true}}""")))
        assertEquals("Run the tests", Transcript().page(EventPage(failed)).promptSuggestion)
    }

    private val approval = obj("""{"id":"ap1","sessionId":"s1","toolName":"AskUserQuestion","status":"PENDING",
        "input":{"questions":[{"question":"Which fix?","header":"Fix","multiSelect":false,
          "options":[{"label":"Load early","description":"Load the script on mount"},{"label":"Retry","description":"Retry the popup"}]}]},
        "translation":{"lang":"zh-Hans","questions":[{"question":"用哪个修法？","header":"修法",
          "options":[{"label":"提前加载","description":"挂载时加载脚本"},{"label":"重试","description":"重试弹窗"}]}]}}""")

    @Test fun aTranslatedQuestionCardShowsAndIsAnsweredInTheOwnersLanguage() {
        val snapshot = SessionSnapshot(obj("""{"id":"s1"}"""), listOf(approval), emptyList(), emptyList(), emptyMap())
        val card = CardCatalog.session("s1", snapshot).single()
        val shown = approvalQuestions(card.source.obj("input")!!).single()
        assertEquals("用哪个修法？", shown.question)
        assertEquals("修法", shown.header)
        assertEquals(listOf("提前加载", "重试"), shown.options.map { it.label })
        assertEquals(listOf("挂载时加载脚本", "重试弹窗"), shown.options.map { it.description })
        // The binding is the engine's own input, so a translation arriving after the card changes no press.
        val untranslated = CardCatalog.session("s1", snapshot.copy(approvals = listOf(JsonObject(approval - "translation")))).single()
        assertEquals(untranslated.binding, card.binding)
        // The answer is keyed by what was shown; the server maps it back to the original.
        val request = CardRequests.build(card, CardVerb.ANSWER, CardInput(selections = mapOf("用哪个修法？" to listOf("提前加载"))))
        val body = Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
        assertEquals(obj("""{"用哪个修法？":["提前加载"]}"""), body["answers"])
        assertNull("no sendAsWritten unless asked", body["sendAsWritten"])
        val asWritten = CardRequests.build(card, CardVerb.ANSWER, CardInput(selections = mapOf("用哪个修法？" to listOf("提前加载")), sendAsWritten = true))
        assertEquals(JsonPrimitive(true), Wire.json.parseToJsonElement(asWritten.body!!.decodeToString()).jsonObject["sendAsWritten"])
    }

    @Test fun aFailedOrAbsentCardTranslationLeavesTheCardAsItCame() {
        val failed = JsonObject(approval + ("translation" to obj("""{"lang":"zh-Hans","failed":true}""")))
        assertSame(failed, Translation.shownApproval(failed))
        val none = JsonObject(approval - "translation")
        assertSame(none, Translation.shownApproval(none))
        val plan = obj("""{"id":"ap2","toolName":"ExitPlanMode","input":{"plan":"1. Load early"},"translation":{"lang":"ja","plan":"1. 早めに読み込む"}}""")
        assertEquals("1. 早めに読み込む", Translation.shownApproval(plan).obj("input")!!["plan"]!!.jsonPrimitive.content)
        val tool = obj("""{"id":"ap3","toolName":"Bash","input":{"command":"ls","description":"List files"},"translation":{"lang":"ja","description":"ファイル一覧"}}""")
        val shownTool = Translation.shownApproval(tool).obj("input")!!
        assertEquals("ファイル一覧", shownTool["description"]!!.jsonPrimitive.content)
        assertEquals("the command is never translated", "ls", shownTool["command"]!!.jsonPrimitive.content)
    }
}

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

    @Test fun theLanguagesAndTheirTagsAreTheSharedOnes() {
        val shared = java.io.File(generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/translation.ts").isFile }, "src/shared/src/translation.ts").readText()
        // The one list both pickers offer, shared's codes in shared's order: English first, then the seven shipped before it grew.
        val sharedCodes = Regex("TRANSLATION_LANGUAGES = \\[([^\\]]*)\\] as const").find(shared)!!.groupValues[1]
            .split(',').map { it.trim().trim('\'') }.filter { it.isNotEmpty() }
        assertEquals(30, sharedCodes.size)
        assertEquals(sharedCodes, Translation.LANGUAGES.map { it.first })
        assertEquals(listOf("en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de"), Translation.LANGUAGES.take(8).map { it.first })
        Translation.LANGUAGES.forEach { (code, name) ->
            val key = if (code.contains('-')) "'$code'" else code
            assertTrue("$code → $name is not shared's", shared.contains("$key: '$name',"))
        }
        assertTrue(shared.contains("DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = '${Translation.DEFAULT_LANGUAGE}'"))
        assertTrue(shared.contains("DEFAULT_AGENT_LANGUAGE = '${Translation.DEFAULT_AGENT_LANGUAGE}' satisfies TranslationLanguage"))
        assertTrue(shared.contains("TRANSLATION_FAILED_CODE = '${Translation.FAILED_CODE}'"))
        assertEquals("Chinese → English", Translation.tag("zh-Hans"))
        assertEquals("Chinese → English", Translation.tag("zh-Hant"))
        assertEquals("Japanese → English", Translation.tag("ja"))
        assertEquals("German → English", Translation.tag("de"))
        // The tag names the agent language, both sides without their parenthesis.
        assertEquals("Chinese → Japanese", Translation.tag("zh-Hans", "ja"))
        assertEquals("English → Chinese", Translation.tag("en", "zh-Hant"))
        assertEquals("Bengali → Ukrainian", Translation.tag("bn", "uk"))
    }

    @Test fun aFailedTurnAndARefusalSayWhyInSharedsReasons() {
        val shared = java.io.File(generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/translation.ts").isFile }, "src/shared/src/translation.ts").readText()
        val sharedReasons = Regex("TRANSLATION_FAILURE_REASONS = \\[([^\\]]*)\\] as const").find(shared)!!.groupValues[1]
            .split(',').map { it.trim().trim('\'') }.filter { it.isNotEmpty() }
        assertEquals(sharedReasons, Translation.FailureReason.entries.map { it.name })
        // OrbitKit's copy (TranslationFailureReason in Translation.swift) lists the same raw values in the same order.
        val root = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/translation.ts").isFile }
        val swift = java.io.File(root, "src/macos/OrbitKit/Sources/OrbitKit/Models/Translation.swift").readText()
        val swiftEnum = Regex("enum TranslationFailureReason[^{]*\\{([^}]*)\\}").find(swift)!!.groupValues[1]
        assertEquals(sharedReasons, Regex("case \\w+ = \"([A-Z_]+)\"").findAll(swiftEnum).map { it.groupValues[1] }.toList())
        assertTrue(shared.contains("failureReason?: TranslationFailureReason;"))
        assertTrue(shared.contains("httpStatus?: number;"))

        val http = Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x","failureReason":"HTTP","httpStatus":503}"""))!!
        assertEquals(Translation.FailureReason.HTTP, http.failureReason)
        assertEquals(503, http.httpStatus)
        Translation.FailureReason.entries.forEach { reason ->
            val t = Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x","failureReason":"${reason.name}"}"""))!!
            assertEquals(reason, t.failureReason)
            assertNull(t.httpStatus)
        }
        // No reason (a turn that failed before it was stored), or one this client does not know: the generic line.
        assertNull(Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x"}"""))!!.failureReason)
        assertNull(Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x","failureReason":"COSMIC_RAY"}"""))!!.failureReason)
        assertNull(Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x","httpStatus":"503"}"""))!!.httpStatus)

        val refusal = io.orbitd.android.core.net.ApiError.parse(422,
            """{"code":"TRANSLATION_FAILED","message":"x","failureReason":"HTTP","httpStatus":429}""".toByteArray())
        assertEquals(Translation.FailureReason.HTTP to 429, Translation.refusalReason(refusal))
        val timeout = io.orbitd.android.core.net.ApiError.parse(422, """{"code":"TRANSLATION_FAILED","failureReason":"TIMEOUT"}""".toByteArray())
        assertEquals(Translation.FailureReason.TIMEOUT to null, Translation.refusalReason(timeout))
        assertNull(Translation.refusalReason(io.orbitd.android.core.net.ApiError.parse(422, """{"code":"TRANSLATION_FAILED"}""".toByteArray())))
        assertNull(Translation.refusalReason(io.orbitd.android.core.net.ApiError.parse(422, """{"code":"OTHER","failureReason":"TIMEOUT"}""".toByteArray())))
        assertNull(Translation.refusalReason(RuntimeException("x")))
    }

    @Test fun preferencesReadOffUnlessSwitchedOnAndTheDefaultLanguageWhenAbsent() {
        assertFalse(Translation.enabled(null))
        assertFalse(Translation.enabled(obj("""{}""")))
        assertFalse(Translation.enabled(obj("""{"translationEnabled":"true"}""")))
        assertTrue(Translation.enabled(obj("""{"translationEnabled":true}""")))
        assertEquals("zh-Hans", Translation.language(obj("""{}""")))
        assertEquals("zh-Hans", Translation.language(obj("""{"translationLanguage":"xx"}""")))
        assertEquals("ja", Translation.language(obj("""{"translationLanguage":"ja"}""")))
        assertEquals("pt", Translation.language(obj("""{"translationLanguage":"pt"}""")))
        // Agents work in: absent (or unknown) is English; any language of the list otherwise.
        assertEquals("en", Translation.agentLanguage(null))
        assertEquals("en", Translation.agentLanguage(obj("""{}""")))
        assertEquals("en", Translation.agentLanguage(obj("""{"translationAgentLanguage":"xx"}""")))
        assertEquals("ja", Translation.agentLanguage(obj("""{"translationAgentLanguage":"ja"}""")))
        assertEquals("sv", Translation.agentLanguage(obj("""{"translationAgentLanguage":"sv"}""")))
        assertFalse("an older server says nothing: unable", Translation.available(obj("""{"id":"u1"}""")))
        assertFalse(Translation.available(obj("""{"translationAvailable":false}""")))
        assertTrue(Translation.available(obj("""{"translationAvailable":true}""")))
    }

    @Test fun translationUnavailableUntilIsReadWhileItLiesAhead() {
        val until = java.time.Instant.parse("2026-11-18T06:01:00.000Z")
        val me = obj("""{"translationAvailable":true,"translationUnavailableUntil":"2026-11-18T06:01:00.000Z"}""")
        assertEquals(until, Translation.unavailableUntil(me, until.minusMillis(1)))
        assertNull("past it, the ordinary tag again", Translation.unavailableUntil(me, until))
        assertNull(Translation.unavailableUntil(obj("""{"translationUnavailableUntil":null}""")))
        assertNull("an older server says nothing", Translation.unavailableUntil(obj("""{"translationAvailable":true}""")))
        assertNull(Translation.unavailableUntil(obj("""{"translationUnavailableUntil":"soon"}""")))
    }

    @Test fun aTurnsTranslationParsesEachStateAndRefusesWhatIsNotOne() {
        val done = Translation.turn(obj("""{"state":"DONE","from":"zh-Hans","original":"修复登录"}"""))!!
        assertEquals(Translation.Turn(Translation.TurnState.DONE, "zh-Hans", "修复登录"), done)
        assertFalse(done.held)
        assertTrue(Translation.turn(obj("""{"state":"TRANSLATING","from":"ja","original":"x"}"""))!!.held)
        assertTrue(Translation.turn(obj("""{"state":"FAILED","from":"ja","original":"x"}"""))!!.held)
        assertFalse(Translation.turn(obj("""{"state":"SENT_AS_WRITTEN","from":"ja","original":"x"}"""))!!.held)
        assertNull(Translation.turn(obj("""{"state":"LOST","from":"ja","original":"x"}""")))
        assertNull(Translation.turn(obj("""{"state":"DONE","from":"xx","original":"x"}""")))
        assertNull(Translation.turn(obj("""{"state":"DONE","from":"ja"}""")))
        assertNull(Translation.turn(JsonNull))
    }

    @Test fun aRepliesTranslationIsItsTextOrItsFailure() {
        assertEquals(Translation.Reply("zh-Hans", "找到了", false), Translation.reply(obj("""{"lang":"zh-Hans","text":"找到了"}""")))
        assertEquals(Translation.Reply("ko", null, true), Translation.reply(obj("""{"lang":"ko","failed":true}""")))
        assertNull(Translation.reply(obj("""{"lang":"ko"}""")))
        assertNull(Translation.reply(obj("""{"lang":"xx","text":"x"}""")))
    }

    @Test fun aReplyAlreadyInTheOwnersLanguageIsDrawnWithNoTranslation() {
        assertNull(Translation.shownReply(obj("""{"lang":"zh-Hans","text":"找到了\n"}"""), "找到了"))
        assertEquals(Translation.Reply("zh-Hans", "找到了", false), Translation.shownReply(obj("""{"lang":"zh-Hans","text":"找到了"}"""), "Found it"))
        assertEquals(Translation.Reply("zh-Hans", null, true), Translation.shownReply(obj("""{"lang":"zh-Hans","failed":true}"""), "找到了"))
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

    /** "Show both languages" (docs/mocks/session-translation/02-bilingual.png): off until the account says so, only while translating. */
    @Test fun bilingualIsAnExplicitTrueWhileTranslating() {
        assertEquals(false, Translation.bilingual(obj("""{"translationEnabled":true}""")))
        assertEquals(true, Translation.bilingual(obj("""{"translationEnabled":true,"translationBilingual":true}""")))
        assertEquals(false, Translation.bilingual(obj("""{"translationEnabled":false,"translationBilingual":true}""")))
        assertEquals(false, Translation.bilingual(obj("""{"translationEnabled":true,"translationBilingual":"true"}""")))
        assertEquals(false, Translation.bilingual(null))
    }

    /** The same English and the same N as the web and iOS for the same reply (Transcript.translation.test.tsx, TranslationTests.swift). */
    @Test fun aLongRepliesEnglishIsCountedAsEveryClientCountsIt() {
        val long = listOf(
            "Done. The popup now opens synchronously on click:",
            "1. The script preloads on page load in a useEffect;",
            "2. The click handler no longer awaits before signInWithPopup;",
            "```ts",
            "useEffect(() => { void loadGoogleScript(); }, []);",
            "```",
            "3. A new LoginPage.safari.test.tsx covers this case.",
            "All tests pass.",
            "The fix is on the branch.",
            "Safari keeps blocking popups that are opened after an await.",
            "Chrome and Firefox were never affected.",
            "Want me to open a pull request?",
        ).joinToString("\n")
        val english = Translation.bilingualEnglish(long)
        assertEquals(false, english.contains("loadGoogleScript(); }"))
        assertEquals(10, Translation.bilingualLineCount(english))
        assertEquals(2, Translation.bilingualLineCount("Found it: Safari blocks popups that aren't opened directly by a click."))
        assertEquals(4, Translation.bilingualLineCount("a".repeat(121) + "\n\n\nb"))
        assertEquals("a\n```\nb", Translation.bilingualEnglish("a\n```\nb"))
    }
}

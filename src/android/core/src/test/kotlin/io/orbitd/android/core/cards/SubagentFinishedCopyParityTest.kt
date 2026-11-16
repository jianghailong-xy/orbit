package io.orbitd.android.core.cards

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The SubAgent finished line's words are the web's (board docs/mocks/subagent-finished-line; web `SubagentFinishedCard.tsx`, which landed
 * first) and OrbitKit's (`SubagentFinished.swift`): every String constant of [SubagentFinishedCard] is a literal or a JSX text on the web,
 * and every one OrbitKit keeps is the same Swift literal; every sentence the Kotlin builds is one template on both; and the reader's
 * patterns are the ones OrbitKit pins. A missing counterpart is a failure, never a skip.
 */
class SubagentFinishedCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/components/SubagentFinishedCard.tsx").isFile }
    private val web = File(root, "src/web/src/components/SubagentFinishedCard.tsx").readText()
    private val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/SubagentFinished.swift").readText()

    private fun swiftHas(literal: String) = assertTrue("SubagentFinished.swift no longer contains $literal", swift.contains(literal))
    /** A Kotlin string as a Swift literal's source: each backslash written twice. */
    private fun swiftLiteral(value: String) = "\"" + value.replace("\\", "\\\\") + "\""

    private fun assertHas(literal: String) = assertTrue("SubagentFinishedCard.tsx no longer contains $literal", web.contains(literal))
    private fun quoted(words: String) = assertHas("'$words'")
    /** Words the web writes as JSX text: between a tag's end (or a line's indent) and the next `<` or `{`. */
    private fun jsx(words: String) = assertTrue("SubagentFinishedCard.tsx no longer draws $words",
        Regex("(>|\\n\\s*)\\s*${Regex.escape(words)}\\s*(<|\\{|\\n)").containsMatchIn(web))

    @Test fun everyConstantIsTheWebsWord() {
        quoted(SubagentFinishedCard.finished)
        quoted(SubagentFinishedCard.didNotFinish)
        quoted(SubagentFinishedCard.showFullResult)
        quoted(SubagentFinishedCard.showLess)
        quoted(SubagentFinishedCard.noResult)
        jsx(SubagentFinishedCard.mark)
        jsx(SubagentFinishedCard.details)
        jsx(SubagentFinishedCard.run)
        jsx(SubagentFinishedCard.itsCard)
        jsx(SubagentFinishedCard.uncommitted)
        jsx(SubagentFinishedCard.queuedBy)
        jsx(SubagentFinishedCard.rawSummary)
        jsx(SubagentFinishedCard.undelivered)
        // Every String constant of the object is held above: a word added there and not here fails.
        val declared = SubagentFinishedCard::class.java.declaredFields.filter { it.type == String::class.java }
        assertEquals(13, declared.size)
    }

    @Test fun everyBuiltSentenceIsOneWebTemplate() {
        val two = SubagentFinished.parse(SubagentFinishedTest.TWO)!!
        assertEquals("2 SubAgents finished", SubagentFinishedCard.title(two))
        assertHas("`\${wake.runs.length} SubAgents finished`")
        assertEquals("1 of 2 failed", SubagentFinishedCard.status(two))
        assertHas("`\${failed} of \${wake.runs.length} failed`")
        // Several that all finished say `done`; one says its own end, lower-cased.
        assertHas("failed > 0 ? `\${failed} of \${wake.runs.length} failed` : 'done'")
        assertHas("return wake.runs[0].status.toLowerCase();")
        // A run's one line: the first line of its result, else why it ended, else No result.
        assertHas("const line = first || run.reason || 'No result';")
        // The marks of several runs' rows.
        assertHas("{ok ? '✓' : '✕'}")
    }

    @Test fun theSteerWordsAreTheBackgroundLinesOwn() {
        // A SubAgent's end written into the running turn says how far it got in a steer's words, as the job's line does (web
        // `steerDeliveryState(...).label` in both): Android draws both through [BackgroundWakeCard.steerState].
        assertEquals("Read in this turn", BackgroundWakeCard.steerReceipt(BackgroundWakeCard.steerState(true, "acknowledged", false)))
        assertEquals("Sending…", BackgroundWakeCard.steerState(true, null, false))
    }

    @Test fun orbitKitKeepsTheSameWords() {
        swiftHas("public static let noResult = \"${SubagentFinishedCard.noResult}\"")
        swiftHas("public static let showFullResult = \"${SubagentFinishedCard.showFullResult}\"")
        swiftHas("public static let showLess = \"${SubagentFinishedCard.showLess}\"")
        swiftHas("public static let details = \"${SubagentFinishedCard.details}\"")
        swiftHas("public static let run = \"${SubagentFinishedCard.run}\"")
        swiftHas("public static let cardLink = \"${SubagentFinishedCard.itsCard}\"")
        swiftHas("public static let changes = \"${SubagentFinishedCard.uncommitted}\"")
        swiftHas("public static let queuedBy = \"${SubagentFinishedCard.queuedBy}\"")
        swiftHas("public static let rawSummary = \"${SubagentFinishedCard.rawSummary}\"")
        swiftHas("public static let previewLines = ${SubagentFinishedCard.resultLines}")
        swiftHas("isOk(wake.runs[0]) ? \"${SubagentFinishedCard.finished}\" : \"${SubagentFinishedCard.didNotFinish}\"")
        swiftHas("return \"\\(wake.runs.count) SubAgents finished\"")
        swiftHas("failed > 0 ? \"\\(failed) of \\(wake.runs.count) failed\" : \"done\"")
        swiftHas("return run.reason ?? noResult")
    }

    @Test fun theReadersPatternsAreTheOnesOrbitKitPins() {
        swiftHas("static let headPattern = ${swiftLiteral(SubagentFinished.headPattern)}")
        swiftHas("static let sentencePattern = ${swiftLiteral(SubagentFinished.sentencePattern)}")
        // The web's block pattern escapes the closing tag's slash, which a Kotlin Regex does not need.
        assertTrue(swift.replace("<\\\\/orbit", "</orbit").contains("static let blockPattern = ${swiftLiteral(SubagentFinished.blockPattern)}"))
    }
}

package io.orbitd.android.translation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The owner cards (board docs/mocks/session-translation/04-owner-cards.html) say the same lines on Android, Web and iOS/macOS: the
 * whole-card flip "Translated · Show original" ↔ "Original · Show translation", and an answer the server could not translate,
 * "Couldn't translate, so it wasn't sent · Retry · Send as written". [TranslationCopyParityTest] checks the words; this checks the
 * lines: each client's words, read from its own copy, in the order its one drawing of each line says them, with "·" between. Every
 * owner card then draws through that one place, so no card can say the line its own way.
 *
 * A client whose source no longer has the place FAILS, naming it: a cross-client check never skips (CrossClientChecksNeverSkipTest).
 */
class OwnerCardTranslationCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src").isDirectory && File(it, "src/macos").isDirectory }

    private fun read(path: String): String = File(root, path).also { assertTrue("$path is gone: move this check with it", it.isFile) }.readText()

    /** The text of [path] from [head] to the first [end] after it, [end] included. */
    private fun part(path: String, head: String, end: String): String {
        val text = read(path)
        val from = text.indexOf(head)
        assertTrue("$path no longer has $head", from >= 0)
        val to = text.indexOf(end, from)
        assertTrue("$path: $head has no end ($end)", to > from)
        return text.substring(from, to + end.length)
    }

    private fun key(name: String) = name.replace("_", "").lowercase()

    /** Each client's own words, by key (SHOW_ORIGINAL and showOriginal are one key). */
    private val androidWords: Map<String, String> = TranslationCopy::class.java.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(null) ?: field.get(TranslationCopy) }.getOrNull() as? String)?.let { key(field.name) to it }
    }.toMap()
    private fun webWords(): Map<String, String> =
        Regex("""(\w+): (?:'([^']*)'|"([^"]*)"),""").findAll(part(WEB_LIB, "export const TRANSLATION_COPY = {", "};"))
            .associate { m -> key(m.groupValues[1]) to (m.groupValues[2].ifEmpty { m.groupValues[3] }) }
    private fun swiftWords(): Map<String, String> =
        Regex("""public static let (\w+) = "([^"]*)"""").findAll(part(SWIFT_COPY, "public enum TranslationCopy {", "\n}\n"))
            .associate { m -> key(m.groupValues[1]) to m.groupValues[2] }

    /**
     * A drawing's two lines, read off its source: [word] finds each reference to the copy (its key in group 1) and [sep] each "·", in
     * the order the source says them. A piece between two "·" is one word, or `flipped ? A : B` — the original's word, then the
     * translation's — so the line is (flipped, as translated).
     */
    private fun lines(source: String, word: Regex, sep: String, words: Map<String, String>, where: String): Pair<String, String> {
        val pieces = mutableListOf(mutableListOf<String>())
        Regex("${word.pattern}|${Regex.escape(sep)}").findAll(source).forEach { m ->
            if (m.value == sep) pieces += mutableListOf<String>()
            else pieces.last() += words[key(m.groupValues[1])] ?: error("$where names ${m.groupValues[1]}, which its copy does not hold")
        }
        assertTrue("$where: every piece is a word, or flipped ? original : translated — $pieces", pieces.all { it.size in 1..2 })
        return pieces.joinToString(" · ") { it.first() } to pieces.joinToString(" · ") { it.last() }
    }

    private val androidWord = Regex("""TranslationCopy\.([A-Z_]+)""")
    private val webWord = Regex("""COPY\.(\w+)""")
    private val swiftWord = Regex("""TranslationCopy\.(\w+)""")

    /** iOS/macOS builds each line as a list of parts, which its foot view draws with "·" between ([SWIFT_FOOT]). */
    private fun swiftLines(source: String): List<String> {
        assertTrue("$SWIFT_FOOT draws \"·\" between a foot's parts", read(SWIFT_FOOT).contains("""if i > 0, !isChip(part) { Text("·")"""))
        val words = swiftWords()
        return Regex("""\[([^\]]*)]""").findAll(source).map { list ->
            swiftWord.findAll(list.groupValues[1]).joinToString(" · ") { words[key(it.groupValues[1])] ?: error("$SWIFT_OWNER names ${it.groupValues[1]}, which its copy does not hold") }
        }.filter { it.isNotEmpty() }.toList()
    }

    @Test fun theFlipSaysTheSameLineOnEveryClient() {
        val expected = "Original · Show translation" to "Translated · Show original"
        assertEquals("Android", expected, lines(part(ANDROID_VIEWS, "fun CardTranslationFoot(", "\n}\n"), androidWord, "Sep(", androidWords, ANDROID_VIEWS))
        assertEquals("Web", expected, lines(part(WEB_PARTS, "export function CardTranslationFoot(", "\n}\n"), webWord, "<Sep />", webWords(), WEB_PARTS))
        // iOS/macOS: two lists of parts, the flipped one first.
        assertEquals("iOS/macOS", listOf(expected.first, expected.second),
            swiftLines(part(SWIFT_OWNER, "public static func foot(translates: Bool, showOriginal: Bool)", "\n    }\n")))
    }

    @Test fun theRefusedAnswerSaysTheSameLineOnEveryClient() {
        val expected = "Couldn't translate, so it wasn't sent · Retry · Send as written"
        assertEquals("Android", expected to expected, lines(part(ANDROID_VIEWS, "fun AnswerNotTranslated(", "\n}\n"), androidWord, "Sep(", androidWords, ANDROID_VIEWS))
        // The web says why through translationFailureSentence('answer', …) (frame 7 B); with no reason it is the GENERIC answer line.
        val genericAnswer = Regex("""GENERIC: \{\s*message: "[^"]*",\s*answer: "([^"]*)",""").find(read(SHARED_TRANSLATION))
            ?.groupValues?.get(1) ?: error("$SHARED_TRANSLATION no longer has TRANSLATION_FAILURE_LINES.GENERIC")
        assertEquals("Web", expected to expected, lines(part(WEB_PARTS, "export function UntranslatedDecisionFoot(", "\n}\n"),
            Regex("""COPY\.(\w+)|translationFailureSentence\('answer'"""), "<Sep />", webWords() + ("" to genericAnswer), WEB_PARTS))
        assertEquals("iOS/macOS", listOf(expected), swiftLines(part(SWIFT_OWNER, "public static let refusedFoot", "\n    ]\n")))
    }

    /** No owner card draws either line itself: each says it through the one drawing above. */
    @Test fun everyOwnerCardDrawsTheLinesFromTheOnePlace() {
        val android = File(root, "src/android/app/src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertEquals("Android says the refusal only in $ANDROID_VIEWS", listOf(File(root, ANDROID_VIEWS)),
            android.filter { it.readText().contains("TranslationCopy.SEND_FAILED") })
        assertEquals("Android says the flip only in $ANDROID_VIEWS", listOf(File(root, ANDROID_VIEWS)),
            android.filter { it.readText().contains("TranslationCopy.SHOW_TRANSLATION") })
        ANDROID_CARDS.forEach { (path, refuses) ->
            val text = read(path)
            assertTrue("$path draws its foot with CardTranslationFoot", text.contains("CardTranslationFoot("))
            if (refuses) assertTrue("$path draws a refused answer with AnswerNotTranslated", text.contains("AnswerNotTranslated("))
        }
        WEB_CARDS.forEach { (path, refuses) ->
            val text = read(path)
            assertTrue("$path draws its foot with useOwnerCardTranslation or useOwnerCardFlip", text.contains("useOwnerCardTranslation(") || text.contains("useOwnerCardFlip("))
            if (refuses) assertTrue("$path draws a refused answer with RefusedAnswerFoot or RefusedSendBack", text.contains("<RefusedAnswerFoot") || text.contains("<RefusedSendBack"))
            assertTrue("$path says no translation words of its own", !Regex("""COPY\.(sendFailed|showOriginal|showTranslation)""").containsMatchIn(text))
        }
        SWIFT_CARDS.forEach { path ->
            val text = read(path)
            // The done card's Not yet refusal arrives as parts its model built (SessionTranslation.refusedAnswerFoot), drawn by TranslationFootView.
            assertTrue("$path draws its foot and refusal from OwnerCardTranslations or TranslationFootView",
                text.contains("OwnerCardTranslations.") || text.contains("TranslationFootView(parts:"))
            assertTrue("$path says no translation words of its own", !Regex("""TranslationCopy\.(sendFailed|showOriginal|showTranslation)""").containsMatchIn(text))
        }
    }

    private companion object {
        const val ANDROID_VIEWS = "src/android/app/src/main/kotlin/io/orbitd/android/translation/TranslationViews.kt"
        const val WEB_LIB = "src/web/src/lib/translation.ts"
        const val WEB_PARTS = "src/web/src/components/TranslationParts.tsx"
        const val SHARED_TRANSLATION = "src/shared/src/translation.ts"
        const val SWIFT_COPY = "src/macos/OrbitKit/Sources/OrbitKit/Models/Translation.swift"
        const val SWIFT_OWNER = "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerCardTranslations.swift"
        const val SWIFT_FOOT = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/TranslationViews.swift"

        /** Each owner card, and whether an answer it sends can be refused untranslated. */
        val ANDROID_CARDS = listOf(
            "src/android/app/src/main/kotlin/io/orbitd/android/cards/BusinessCard.kt" to true,
            "src/android/app/src/main/kotlin/io/orbitd/android/cards/OwnerRequestViews.kt" to true,
            "src/android/app/src/main/kotlin/io/orbitd/android/projects/ProjectDoneCards.kt" to true,
            "src/android/app/src/main/kotlin/io/orbitd/android/cards/QuestionRecordViews.kt" to false,
            "src/android/app/src/main/kotlin/io/orbitd/android/cards/CrossingCardViews.kt" to false,
            "src/android/app/src/main/kotlin/io/orbitd/android/projects/ProjectsScreen.kt" to false,
            "src/android/app/src/main/kotlin/io/orbitd/android/projects/ProjectSettings.kt" to false,
            "src/android/app/src/main/kotlin/io/orbitd/android/projects/StartProjectCard.kt" to false,
        )
        val WEB_CARDS = listOf(
            "src/web/src/components/CoordinatorQuestionCard.tsx" to true,
            "src/web/src/components/OwnerRequestCard.tsx" to true,
            "src/web/src/components/ProjectSettlementCard.tsx" to true,
            "src/web/src/components/OwnerConfirmationCard.tsx" to true,
            "src/web/src/components/EvidenceDecisionCard.tsx" to false,
            "src/web/src/components/CriteriaDecisionCard.tsx" to false,
            "src/web/src/components/CrossingDecisionCard.tsx" to false,
            "src/web/src/components/StartProjectCard.tsx" to false,
        )
        val SWIFT_CARDS = listOf(
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectDoneCards.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectCrossingRow.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/CrossingDecisionCard.swift",
        )
    }
}

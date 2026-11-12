package io.orbitd.android.translation

import io.orbitd.android.core.translation.Translation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Settings › Translation says the same words on Android as on Web and on iOS/macOS (project instructions: "Keep the copy strings
 * identical across clients"): every [TranslationCopy] string, and every language's name, appears in each client's own source.
 *
 * The three clients land as separate tasks. A client whose source does not yet hold the feature at all (no "Translate conversations")
 * is skipped, and named as skipped, rather than failed; once it holds it, every word has to match.
 */
class TranslationCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src").isDirectory && File(it, "src/macos").isDirectory }

    private fun words(): Map<String, String> = TranslationCopy::class.java.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(null) ?: field.get(TranslationCopy) }.getOrNull() as? String)?.let { field.name to it }
    }.toMap()

    /** A client's sources as one text: inline tags (`<code>`) out, string concatenation joined, every run of white space one space — so a sentence
     * that wraps, or wraps a `<code>` round a name, still reads as the sentence. */
    private fun source(dir: String, extensions: Set<String>): String = File(root, dir).walkTopDown()
        .filter { it.isFile && it.extension in extensions && !it.name.contains(".test.") && listOf("/Tests/", "/.build/", "/DerivedData/").none(it.path::contains) }
        .joinToString("\n") { it.readText() }
        .replace(Regex("\"\\s*\\+\\s*\""), "").replace(Regex("'\\s*\\+\\s*'"), "")
        .replace(Regex("</?(code|b|strong|em|i)>"), "").replace(Regex("\\s+"), " ")

    private fun missing(source: String): Map<String, String> =
        (words() + Translation.LANGUAGES.associate { (code, name) -> code to name }).filterValues { !source.contains(it) }

    @Test fun theCopyHoldsEveryWordTheBoardNames() {
        val all = words()
        assertTrue("TranslationCopy holds no words", all.size >= 19)
        // English only (CLAUDE.md §5).
        all.forEach { (name, value) -> assertTrue("$name is not English: $value", value.none { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }) }
        assertEquals("Couldn't translate, so it wasn't sent", TranslationCopy.SEND_FAILED)
        assertEquals("Translates when the reply is done", TranslationCopy.REPLY_PENDING)
    }

    @Test fun webSaysTheSameWords() {
        // The web draws the language names from @orbit/shared (TRANSLATION_LANGUAGE_NAMES), so its words are its own and shared's.
        val web = source("src/web/src", setOf("ts", "tsx")) + " " + source("src/shared/src", setOf("ts"))
        assumeTrue("Web has no Settings › Translation yet", web.contains(TranslationCopy.TRANSLATE_CONVERSATIONS))
        assertEquals("Android words the web does not say", emptyMap<String, String>(), missing(web))
    }

    @Test fun iosAndMacosSayTheSameWords() {
        val swift = source("src/macos", setOf("swift"))
        assumeTrue("iOS/macOS has no Settings › Translation yet", swift.contains(TranslationCopy.TRANSLATE_CONVERSATIONS))
        assertEquals("Android words iOS/macOS does not say", emptyMap<String, String>(), missing(swift))
    }

    @Test fun theLanguagesAreTheSharedSeven() {
        val shared = File(root, "src/shared/src/translation.ts").readText()
        Translation.LANGUAGES.forEach { (_, name) -> assertTrue("\"$name\" is not in src/shared", shared.contains("'$name'")) }
    }
}

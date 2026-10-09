package io.orbitd.android.management

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Settings → Access tokens, a DeepSeek key's balance, the smart model selection switch and sign out say what iOS says, byte for byte: every
 * String constant (and every tab's words) appears as a literal in the Swift source it was ported from. The one difference is the
 * coordinator's, on A13-16: iOS opens the top-up page "in Safari", Android "in your browser". */
class SettingsCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun swift(vararg files: String) = files.joinToString("\n") { File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/$it").readText() }
        .replace(Regex("\"\\s*\\+\\s*\""), "")

    private fun constants(holder: Any): Map<String, String> = holder.javaClass.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(holder) }.getOrNull() as? String)?.let { field.name to it }
    }.toMap()

    private fun missing(words: Map<String, String>, source: String) = words.filterValues { !source.contains("\"$it\"") }

    @Test fun accessTokenWordsAreIosOwn() {
        val source = swift("AccessTokensList.swift", "SettingsHome.swift")
        val words = constants(AccessTokens) + AccessTokens.Tab.entries.flatMap { listOf("${it.name}.label" to it.label, "${it.name}.empty" to it.empty) }
        assertTrue("AccessTokens holds no words", words.size >= 12)
        assertEquals("AccessTokens strings not in AccessTokensList.swift", emptyMap<String, String>(), missing(words, source))
    }

    @Test fun theSmartModelSelectionSwitchAndSignOutSayWhatIosSays() {
        val source = swift("SettingsHome.swift")
        listOf(SMART_MODEL_SELECTION, SMART_MODEL_SELECTION_HINT, SETTINGS_SIGN_OUT_TITLE).forEach {
            assertTrue("\"$it\" is not in SettingsHome.swift", source.contains("\"$it\""))
        }
    }

    @Test fun deepSeekBalanceWordsAreIosOwnButTheBrowser() {
        val source = swift("DeepSeekBalance.swift", "ProvidersOverview.swift")
        val words = constants(DeepSeekBalance)
        assertTrue("DeepSeekBalance holds no words", words.size >= 25)
        assertEquals("DeepSeekBalance strings not in DeepSeekBalance.swift", mapOf("OPENS_IN_BROWSER" to DeepSeekBalance.OPENS_IN_BROWSER),
            missing(words, source))
        // The platform's difference, and only that: iOS's sentence with Safari, Android's with the browser.
        assertTrue(source.contains("\"Opens platform.deepseek.com/top_up in Safari.\""))
        assertEquals("Opens platform.deepseek.com/top_up in your browser.", DeepSeekBalance.OPENS_IN_BROWSER)
    }
}

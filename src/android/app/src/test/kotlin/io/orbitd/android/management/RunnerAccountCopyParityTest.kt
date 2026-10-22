package io.orbitd.android.management

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Removing Default from Orbit and bringing it back say what the web says, word for word: each RunnerAccountCopy sentence is the one
 * src/web/src/lib/runnerAccountCopy.ts declares — an `export function`'s single template with its `${parameter}`s, or an `export const`
 * — read as text. Held to the web rather than to Swift, so whichever native client lands first changes nothing here. A missing file
 * fails, never skips.
 */
class RunnerAccountCopyParityTest {
    private val source: String by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/web/src/lib").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", root)
        File(root, "src/web/src/lib/runnerAccountCopy.ts").also { assertTrue("runnerAccountCopy.ts is missing", it.isFile) }.readText()
            .replace(Regex("""'\s*\+\s*'"""), "")
    }
    /** Each sentence with values, by its name: its template with every `${parameter}` written `{parameter}`. */
    private val templates by lazy {
        Regex("""^export function (\w+)\([^)]*\): string \{\n {2}return `([^`]*)`;\n\}$""", RegexOption.MULTILINE).findAll(source)
            .associate { it.groupValues[1] to it.groupValues[2].replace(Regex("""\$\{(\w+)\}"""), "{$1}") }
    }
    private val constants by lazy {
        Regex("""^export const ([A-Z0-9_]+) =\s*'([^'\n]*)';$""", RegexOption.MULTILINE).findAll(source).associate { it.groupValues[1] to it.groupValues[2] }
    }

    @Test fun everySentenceIsTheWebsWordForWord() {
        val android = mapOf(
            "runnerAccountRemoveTitle" to RunnerAccountCopy.removeTitle("{name}"),
            "runnerDefaultRemoveDetail" to RunnerAccountCopy.defaultRemoveDetail("{runner}", "{cli}"),
            "runnerAccountRemoveDetailAutomatic" to RunnerAccountCopy.removeDetailAutomatic("{runner}"),
            "runnerAccountRemoveDetailLast" to RunnerAccountCopy.removeDetailLast("{runner}", "{name}"),
            "runnerDefaultRemovedLine" to RunnerAccountCopy.defaultRemovedLine("{name}", "{dir}"),
            "RUNNER_DEFAULT_USE_AGAIN" to RunnerAccountCopy.USE_AGAIN,
            "runnerDefaultUseAgainFailed" to RunnerAccountCopy.useAgainFailed("{name}"))
        val web = templates + constants
        for ((name, said) in android) assertEquals(name, web[name], said)
        // Every sentence of the web's is said here but the two of the workspace form's account field, which no Android page has.
        assertEquals(setOf("ACCOUNT_SELECT_DEFAULT_REMOVED", "ACCOUNT_SELECT_GONE_AUTOMATIC"), web.keys - android.keys)
    }
}

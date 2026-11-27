package io.orbitd.android.management

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Removing Default from Orbit, bringing it back and Set as default say what the web says, word for word: each RunnerAccountCopy sentence is the one
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
            "RUNNER_ACCOUNT_REMOVE_DETAIL" to RunnerAccountCopy.REMOVE_DETAIL,
            "runnerDefaultUseAgainFailed" to RunnerAccountCopy.useAgainFailed("{name}"),
            "runnerAccountInUseOne" to RunnerAccountCopy.inUseOne("{engine}"),
            "runnerAccountInUseMany" to RunnerAccountCopy.inUseMany("{engine}", 7).replace("7", "{count}"),
            "runnerAccountMovingOne" to RunnerAccountCopy.movingOne("{engine}"),
            "runnerAccountMovingMany" to RunnerAccountCopy.movingMany("{engine}", 7).replace("7", "{count}"),
            "RUNNER_ACCOUNT_IN_USE_OPEN" to RunnerAccountCopy.IN_USE_OPEN,
            "RUNNER_ACCOUNT_IN_USE_RUNNING" to RunnerAccountCopy.IN_USE_RUNNING,
            "RUNNER_ACCOUNT_IN_USE_WAITING" to RunnerAccountCopy.IN_USE_WAITING,
            "RUNNER_ACCOUNT_IN_USE_UNTITLED" to RunnerAccountCopy.IN_USE_UNTITLED,
            "RUNNER_ACCOUNT_SET_DEFAULT" to RunnerAccountCopy.SET_DEFAULT,
            "RUNNER_ACCOUNT_SET_DEFAULT_HINT" to RunnerAccountCopy.SET_DEFAULT_HINT,
            "RUNNER_ACCOUNT_SET_DEFAULT_OFFLINE" to RunnerAccountCopy.SET_DEFAULT_OFFLINE,
            "RUNNER_ACCOUNT_SET_DEFAULT_UPDATE" to RunnerAccountCopy.SET_DEFAULT_UPDATE,
            "RUNNER_ACCOUNT_SET_DEFAULT_BUSY" to RunnerAccountCopy.SET_DEFAULT_BUSY,
            "runnerAccountSetDefaultTitle" to RunnerAccountCopy.setDefaultTitle("{name}"),
            "runnerAccountSetDefaultDetail" to RunnerAccountCopy.setDefaultDetail("{name}", "{defaultDir}", "{defaultName}", "{dir}", "{runner}"),
            "RUNNER_ACCOUNT_SET_DEFAULT_CONFIRM" to RunnerAccountCopy.SET_DEFAULT_CONFIRM,
            "runnerAccountSettingDefault" to RunnerAccountCopy.settingDefault("{name}"),
            "runnerAccountSettingDefaultOne" to RunnerAccountCopy.settingDefaultOne("{name}"),
            "runnerAccountSettingDefaultMany" to RunnerAccountCopy.settingDefaultMany("{name}", 7).replace("7", "{count}"),
            "RUNNER_ACCOUNT_SETTING_DEFAULT_TERMINAL" to RunnerAccountCopy.SETTING_DEFAULT_TERMINAL,
            "runnerAccountSetDefaultFailed" to RunnerAccountCopy.setDefaultFailed("{name}"),
            "RUNNER_ACCOUNT_SET_DEFAULT_UNCHANGED" to RunnerAccountCopy.SET_DEFAULT_UNCHANGED,
            "RUNNER_ACCOUNT_FORMER_DEFAULT" to RunnerAccountCopy.FORMER_DEFAULT,
            "runnerDefaultSignOutTitle" to RunnerAccountCopy.defaultSignOutTitle("{name}"),
            "runnerDefaultSignOutDetail" to RunnerAccountCopy.defaultSignOutDetail("{runner}"),
            "runnerDefaultSignOutTerminal" to RunnerAccountCopy.defaultSignOutTerminal("{runner}", "{command}"),
            "RUNNER_DEFAULT_SIGN_OUT_CONFIRM" to RunnerAccountCopy.DEFAULT_SIGN_OUT_CONFIRM,
            "RUNNER_DEFAULT_SIGN_OUT" to RunnerAccountCopy.DEFAULT_SIGN_OUT,
            "RUNNER_DEFAULT_SIGNING_OUT" to RunnerAccountCopy.DEFAULT_SIGNING_OUT,
            "runnerDefaultSignOutRunningOne" to RunnerAccountCopy.defaultSignOutRunningOne("{name}"),
            "runnerDefaultSignOutRunningMany" to RunnerAccountCopy.defaultSignOutRunningMany(7, "{name}").replace("7", "{count}"),
            "RUNNER_DEFAULT_SIGN_OUT_RUNNING_DETAIL" to RunnerAccountCopy.DEFAULT_SIGN_OUT_RUNNING_DETAIL,
            "runnerDefaultSignOutFailed" to RunnerAccountCopy.defaultSignOutFailed("{name}"))
        val web = templates + constants
        for ((name, said) in android) assertEquals(name, web[name], said)
        // Every sentence of the web's is said here but the two of the workspace form's account field, which no Android page has.
        assertEquals(setOf("ACCOUNT_SELECT_DEFAULT_REMOVED", "ACCOUNT_SELECT_GONE_AUTOMATIC"), web.keys - android.keys)
    }
}

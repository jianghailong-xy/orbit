package io.orbitd.android.composer

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The welcome card says what the web's `src/web/src/lib/welcomeCopy.ts` says, word for word: every constant, the examples, both
 * templates, and the same declaration names. Reads that file as text; a missing file fails, never skips.
 */
class WelcomeCopyParityTest {
    private val root: File by lazy {
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, WEB).isFile }
            .also { assertNotNull("$WEB was not found above the test's working directory", it) }!!
    }
    private val webSource: String by lazy { File(root, WEB).readText() }

    /** `export const NAME =\n  'text';` with the line break flattened. */
    private val webConstants: Map<String, String> by lazy {
        Regex("""export const ([A-Z0-9_]+) =\s*'([^'\n]*)';""").findAll(webSource).associate { it.groupValues[1] to it.groupValues[2] }
    }

    private val kotlinNames = mapOf(
        "WELCOME_LEAD" to WelcomeCopy.WELCOME_LEAD,
        "WELCOME_COMPUTER" to WelcomeCopy.WELCOME_COMPUTER,
        "WELCOME_COMPUTER_MANAGED" to WelcomeCopy.WELCOME_COMPUTER_MANAGED,
        "WELCOME_COMPUTER_OWN" to WelcomeCopy.WELCOME_COMPUTER_OWN,
        "WELCOME_OWN_INSTEAD" to WelcomeCopy.WELCOME_OWN_INSTEAD,
        "WELCOME_COMPUTER_DONE" to WelcomeCopy.WELCOME_COMPUTER_DONE,
        "WELCOME_WAITING_CONNECT" to WelcomeCopy.WELCOME_WAITING_CONNECT,
        "WELCOME_HAVING_TROUBLE" to WelcomeCopy.WELCOME_HAVING_TROUBLE,
        "WELCOME_MODEL" to WelcomeCopy.WELCOME_MODEL,
        "WELCOME_MODEL_HELP" to WelcomeCopy.WELCOME_MODEL_HELP,
        "WELCOME_MODEL_DONE" to WelcomeCopy.WELCOME_MODEL_DONE,
        "WELCOME_AFTER_COMPUTER" to WelcomeCopy.WELCOME_AFTER_COMPUTER,
        "WELCOME_AFTER_STEP_ONE" to WelcomeCopy.WELCOME_AFTER_STEP_ONE,
        "WELCOME_FIRST" to WelcomeCopy.WELCOME_FIRST,
        "WELCOME_FIRST_HELP" to WelcomeCopy.WELCOME_FIRST_HELP,
        "WELCOME_FOOT_WAIT" to WelcomeCopy.WELCOME_FOOT_WAIT,
        "WELCOME_FOOT_SEND_NOW" to WelcomeCopy.WELCOME_FOOT_SEND_NOW,
        "WELCOME_FOOT_READY" to WelcomeCopy.WELCOME_FOOT_READY,
        "WELCOME_PLACEHOLDER" to WelcomeCopy.WELCOME_PLACEHOLDER,
    )

    @Test fun everyConstantMatchesTheWebWordForWord() {
        assertEquals("every web constant is listed here", webConstants.keys, kotlinNames.keys)
        for ((name, value) in kotlinNames) assertEquals("$name drifted from welcomeCopy.ts", webConstants[name], value)
    }

    @Test fun theExamplesMatchTheWebInOrder() {
        val block = Regex("""WELCOME_EXAMPLES = \[(.*?)] as const""", RegexOption.DOT_MATCHES_ALL).find(webSource)
        assertNotNull("WELCOME_EXAMPLES changed shape in welcomeCopy.ts", block)
        val web = Regex("""'([^'\n]*)'""").findAll(block!!.groupValues[1]).map { it.groupValues[1] }.toList()
        assertEquals(web, WelcomeCopy.WELCOME_EXAMPLES)
    }

    @Test fun theTemplatesMatchTheWeb() {
        assertTrue("welcomeTitle changed in welcomeCopy.ts", webSource.contains("return first ? `Welcome to Orbit, \${first}` : 'Welcome to Orbit';"))
        assertTrue("welcomeComputerReady changed in welcomeCopy.ts", webSource.contains("welcomeComputerReady = (machine: string) => `\${machine} is ready`"))
        assertEquals("Welcome to Orbit, Mia", WelcomeCopy.welcomeTitle("Mia Chen"))
        assertEquals("Welcome to Orbit, Mia", WelcomeCopy.welcomeTitle("  Mia  "))
        assertEquals("Welcome to Orbit", WelcomeCopy.welcomeTitle(""))
        assertEquals("Welcome to Orbit", WelcomeCopy.welcomeTitle(null))
        assertEquals("managed-mia is ready", WelcomeCopy.welcomeComputerReady("managed-mia"))
    }

    @Test fun bothFilesDeclareTheSameNames() {
        val web = Regex("""export const (\w+)""").findAll(webSource).map { it.groupValues[1] }.toSet()
        val kotlinSource = File(root, KOTLIN).readText()
        val kotlin = Regex("""^    (?:const val|val|fun) (\w+)""", RegexOption.MULTILINE).findAll(kotlinSource).map { it.groupValues[1] }.toSet()
        assertEquals(web, kotlin)
    }

    /** The welcome card's sign-in says what the web's RunnerSignIn says: its key button, its hint, and "Sign in to <engine>". */
    @Test fun theSignInWordsAreTheWebRunnerSignIns() {
        val web = File(root, "src/web/src/components/RunnerSignIn.tsx").readText()
        assertTrue("Use an API key instead moved in RunnerSignIn.tsx", web.contains(WelcomeSignInCopy.USE_API_KEY_INSTEAD))
        assertTrue("the key hint moved in RunnerSignIn.tsx", web.contains(WelcomeSignInCopy.KEY_HINT))
        assertTrue("Sign in to <engine> moved in RunnerSignIn.tsx", web.contains("`Sign in to \${ENGINE_NAME[engine]}`"))
    }

    private companion object {
        const val WEB = "src/web/src/lib/welcomeCopy.ts"
        const val KOTLIN = "src/android/app/src/main/kotlin/io/orbitd/android/composer/WelcomeCopy.kt"
    }
}

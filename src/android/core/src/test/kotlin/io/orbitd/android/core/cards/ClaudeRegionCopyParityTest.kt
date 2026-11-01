package io.orbitd.android.core.cards

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The Claude region check's words (docs/claude-region-check-contract.md, "Copy of record") are the web's `claudeRegionCopy.ts` and
 * OrbitKit's `ClaudeRegionCopy.swift`, and the sentences behind them the shared ones — the refusal and the stopped sentence
 * (`src/shared/src/claude-region-check.ts`), the code (`dto.ts`) and Anthropic's page (`claude-regions.ts`). Kotlin cannot import any of
 * them, so this reads the files as text and holds every ClaudeRegionCopy word to the web declaration of the same name and to the Swift
 * one, rendering each template with sentinels to compare the whole sentence (OrbitKit's ClaudeRegionCopyParityTests, ported). A missing
 * file or counterpart is a failure, never a skip.
 */
class ClaudeRegionCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .firstOrNull { File(it, WEB).isFile } ?: throw AssertionError("$WEB was not found above ${System.getProperty("user.dir")}")
    private fun source(relative: String) = File(root, relative).also { assertTrue("$relative is missing", it.isFile) }.readText()
    /** The file with every run of whitespace read as one space: where a declaration wraps is a formatting decision; the words are the
     * contract. */
    private fun flat(relative: String) = source(relative).replace(Regex("\\s+"), " ")
    private fun assertSays(said: String, literal: String, file: String) = assertTrue("$file no longer says $literal", said.contains(literal))

    /** Every Kotlin constant, by its web name. */
    private val constants = mapOf(
        "CLAUDE_REGION_SUPPORTED_REGIONS" to ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS,
        "CLAUDE_REGION_USE_ANOTHER_PROVIDER" to ClaudeRegionCopy.CLAUDE_REGION_USE_ANOTHER_PROVIDER,
        "CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE" to ClaudeRegionCopy.CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE,
        "CLAUDE_REGION_CHECK_AGAIN" to ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN,
        "CLAUDE_REGION_ATTENTION" to ClaudeRegionCopy.CLAUDE_REGION_ATTENTION,
        "CLAUDE_REGION_NOT_SUPPORTED" to ClaudeRegionCopy.CLAUDE_REGION_NOT_SUPPORTED,
        "CLAUDE_REGION_CHECK_FAILED" to ClaudeRegionCopy.CLAUDE_REGION_CHECK_FAILED,
    )

    /** Every Kotlin template by its web name, rendered with the web's own `${…}` holes. */
    private val templates = mapOf(
        "claudeRegionCantUseAnthropicOn" to ("(machine: string)" to ClaudeRegionCopy.claudeRegionCantUseAnthropicOn("\${machine}")),
        "anthropicUnavailableOn" to ("(machine: string)" to ClaudeRegionCopy.anthropicUnavailableOn("\${machine}")),
        "claudeRegionMachineNote" to ("(region: string)" to ClaudeRegionCopy.claudeRegionMachineNote("\${region}")),
        "claudeRegionAttentionDetail" to ("(region: string)" to ClaudeRegionCopy.claudeRegionAttentionDetail("\${region}")),
    )

    /** The web's declarations this app has no surface for: a grouped Claude Code head counting its accounts (the phone's row says Region
     * not supported and nothing else, board 03), and the new-session hero's Details link — Android's new session has no hero line; its
     * engine list says the reason, and the row opens the machine's Claude Code page. */
    private val webOnly = setOf("claudeRegionAccounts", "CLAUDE_REGION_DETAILS")

    @Test fun everyConstantIsTheWebsAndTheSwifts() {
        val web = flat(WEB)
        val swift = flat(SWIFT)
        for ((name, value) in constants) {
            assertSays(web, "export const $name = '$value';", WEB)
            assertSays(swift, "public static let $name = \"$value\"", SWIFT)
        }
        // The code and Anthropic's page are Swift's too.
        assertSays(swift, "public static let CLAUDE_REGION_UNSUPPORTED = \"${ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED}\"", SWIFT)
        assertSays(swift, "public static let CLAUDE_REGION_SUPPORTED_REGIONS_URL = \"${ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS_URL}\"", SWIFT)
    }

    @Test fun everyTemplateIsTheWebsWholeSentenceAndTheSwifts() {
        val web = flat(WEB)
        val swift = flat(SWIFT)
        for ((name, template) in templates) {
            val (parameters, rendered) = template
            assertSays(web, "export const $name = $parameters: string => `$rendered`;", WEB)
            // Swift interpolates the same names: \(machine), \(region).
            assertSays(swift, "\"" + rendered.replace(Regex("\\$\\{(\\w+)\\}"), "\\\\($1)") + "\"", SWIFT)
        }
        assertSays(swift, "\"" + ClaudeRegionCopy.claudeRegionCantUseAnthropicOn("\\(machine)") + "\"", SWIFT)
    }

    /** The subject and the check line hold more than holes, so each piece is asserted as the web writes it, and the Kotlin sentence rebuilt
     * from those pieces. */
    @Test fun theSubjectAndTheCheckLineAreTheWebs() {
        val web = flat(WEB)
        assertSays(web, "export const claudeRegionSubject = (code: string | null): string => " +
            "code ? `\${CLAUDE_REGION_UNSUPPORTED} · \${code}` : CLAUDE_REGION_UNSUPPORTED;", WEB)
        assertEquals("CLAUDE_REGION_UNSUPPORTED · CN", ClaudeRegionCopy.claudeRegionSubject("CN"))
        assertEquals("CLAUDE_REGION_UNSUPPORTED", ClaudeRegionCopy.claudeRegionSubject(null))
        assertSays(web, "export const claudeRegionChecked = (when: string, region: string, viaProxy: boolean): string => " +
            "`Checked \${when} · Claude’s connection: \${region} (\${viaProxy ? 'through a proxy' : 'no proxy'})`;", WEB)
        for ((viaProxy, words) in listOf(true to "through a proxy", false to "no proxy")) {
            assertEquals("Checked \${when} · Claude’s connection: \${region} ($words)",
                ClaudeRegionCopy.claudeRegionChecked("\${when}", "\${region}", viaProxy))
        }
        assertSays(flat(SWIFT), "\"Checked \\(when) · Claude’s connection: \\(region) (\\(viaProxy ? \"through a proxy\" : \"no proxy\"))\"", SWIFT)
    }

    /** The card's body is the refusal sentence behind its code: the web slices it off the shared writer, so the Kotlin sentence is held to
     * that writer's template. */
    @Test fun theBodyIsTheSharedRefusalWithoutItsCode() {
        assertSays(flat(WEB), "export const claudeRegionConnectionIsIn = (machine: string, region: string): string => " +
            "claudeRegionRefusedError(machine, region).slice(`\${CLAUDE_REGION_UNSUPPORTED}: `.length);", WEB)
        assertSays(flat(SHARED_RULES), "return `\${CLAUDE_REGION_UNSUPPORTED}: " +
            ClaudeRegionCopy.claudeRegionConnectionIsIn("\${machine}", "\${region}") + "`;", SHARED_RULES)
        assertSays(flat(SWIFT), "\"" + ClaudeRegionCopy.claudeRegionConnectionIsIn("\\(machine)", "\\(region)") + "\"", SWIFT)
    }

    /** The transcript reads a stopped turn by the whole shape of the shared stopped sentence. */
    @Test fun theStoppedSentenceIsTheSharedOne() {
        val code = ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED
        val sentence = ClaudeRegion.STOPPED_LEAD + "\${machine}" + ClaudeRegion.STOPPED_MIDDLE + "\${region}" + ClaudeRegion.STOPPED_TAIL
        assertSays(flat(SHARED_RULES), "return `" + sentence.replace(code, "\${$code}") + "`;", SHARED_RULES)
    }

    /** The code, Anthropic's page and the Anthropic preset are the shared constants. */
    @Test fun theCodeThePageAndThePresetAreTheShared() {
        assertSays(flat(DTO), "export const CLAUDE_REGION_UNSUPPORTED = '${ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED}';", DTO)
        assertSays(flat(WEB), "export const CLAUDE_REGION_SUPPORTED_REGIONS_URL = CLAUDE_REGIONS_SOURCE_URL;", WEB)
        assertSays(flat(SHARED_LIST), "export const CLAUDE_REGIONS_SOURCE_URL = '${ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS_URL}';", SHARED_LIST)
        assertSays(flat(SHARED_RULES), "const ANTHROPIC_PRESET = '${ClaudeRegion.ANTHROPIC_PRESET}';", SHARED_RULES)
    }

    /** The card's feet are the web card's own, and OrbitKit's. */
    @Test fun theCardsFeetAreTheWebCardsAndTheSwifts() {
        val card = flat(WEB_CARD)
        assertSays(card, "waitingFoot: '${SessionRunStart.waitingFoot}',", WEB_CARD)
        assertSays(card, "endedFoot: '${SessionRunStart.endedFoot}',", WEB_CARD)
        val swift = flat(SWIFT_CARD)
        assertSays(swift, "static let waitingFoot = \"${SessionRunStart.waitingFoot}\"", SWIFT_CARD)
        assertSays(swift, "static let endedFoot = \"${SessionRunStart.endedFoot}\"", SWIFT_CARD)
    }

    /** A runner page's buttons are title case: its Check Again is the web's words, capitalized — OrbitKit's own. */
    @Test fun theRunnerPagesCheckAgainIsTheWebsInTitleCase() {
        assertEquals(ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN.split(" ").joinToString(" ") { it.replaceFirstChar(Char::uppercase) },
            ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE)
        assertSays(flat(SWIFT), "public static let CLAUDE_REGION_CHECK_AGAIN_TITLE = \"${ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE}\"", SWIFT)
    }

    /** Every word the web file exports is either here or named as the web's alone, and every word here is held above: a sentence added at
     * one end and not the other fails. */
    @Test fun everyWebDeclarationIsPortedOrNamedWebOnly() {
        val names = Regex("^export const (\\w+)", RegexOption.MULTILINE).findAll(source(WEB)).map { it.groupValues[1] }.toList()
        val ported = constants.keys + templates.keys +
            setOf("CLAUDE_REGION_SUPPORTED_REGIONS_URL", "claudeRegionConnectionIsIn", "claudeRegionSubject", "claudeRegionChecked")
        assertTrue("no declarations read from $WEB", names.isNotEmpty())
        for (name in names) assertTrue("$WEB declares $name, which ClaudeRegionCopy neither ports nor names web-only", name in ported || name in webOnly)
        assertTrue("a web-only name the web no longer declares: ${webOnly - names.toSet()}", names.containsAll(webOnly))
        // Kotlin's own: the constants above, the code (dto.ts), Anthropic's page and the runner page's title-case press (Swift's).
        val declared = ClaudeRegionCopy::class.java.declaredFields.filter { it.type == String::class.java }.map { it.name }.toSet()
        assertEquals(constants.keys + setOf("CLAUDE_REGION_UNSUPPORTED", "CLAUDE_REGION_SUPPORTED_REGIONS_URL", "CLAUDE_REGION_CHECK_AGAIN_TITLE"), declared)
    }

    private companion object {
        const val WEB = "src/web/src/lib/claudeRegionCopy.ts"
        const val WEB_CARD = "src/web/src/components/RunNeverStartedCard.tsx"
        const val SWIFT = "src/macos/OrbitKit/Sources/OrbitKit/App/ClaudeRegionCopy.swift"
        const val SWIFT_CARD = "src/macos/OrbitKit/Sources/OrbitKit/App/SessionRunStart.swift"
        const val SHARED_RULES = "src/shared/src/claude-region-check.ts"
        const val SHARED_LIST = "src/shared/src/claude-regions.ts"
        const val DTO = "src/shared/src/dto.ts"
    }
}

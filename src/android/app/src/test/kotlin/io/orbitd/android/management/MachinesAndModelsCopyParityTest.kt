package io.orbitd.android.management

import io.orbitd.android.core.cards.AntigravityRepair
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Machines & models page's words are iOS's (5e75edbde), byte for byte, and so is what sends a reader there (39f906344): the Antigravity
 * repair card, and where the people of a shared pool see it. No product string still points at a Providers page. */
class MachinesAndModelsCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).readText()
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    private fun constants(holder: Any): Map<String, String> = holder.javaClass.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(holder) }.getOrNull() as? String)?.let { field.name to it }
    }.toMap()

    /** Every constant of Machines & models is a literal in the Swift it was ported from: Machines & models and ProvidersOverview, the page's
     * name (AppSection), and the engine page's install words (RunnerEnginePage). */
    @Test fun machinesAndModelsWordsAreIosOwn() {
        val source = listOf("${kit}MachinesAndModels.swift", "${kit}ProvidersOverview.swift", "${kit}AppSection.swift", "${views}RunnerEnginePage.swift")
            .joinToString("\n") { read(it) }
        val words = constants(MachinesAndModels)
        assertTrue("MachinesAndModels holds no words", words.size >= 14)
        assertEquals("MachinesAndModels strings not in the Swift sources", emptyMap<String, String>(), words.filterValues { !source.contains("\"$it\"") })
        // The sentences built around a name keep iOS's words around it.
        listOf("\"\\(machine) is offline\"", "\"\\(machine) has no coding CLI signed in\"",
            "\"Last seen \\(", "\"Never checked in\"", "\" · its subscriptions are unavailable until it’s back\"", "\"\\(pool) is unavailable\"",
            "\"\\(reason) · no session can start on it\"", " · \\(busy) / \\(all) slots busy\"", "\"\\(active) / \\(max) running\"",
            "\"Install failed\"", "\"Update failed\"", "\"Updating…\"",
            "\"Engines not reported\"", "\"1 engine not updating\"", "\"All signed in\"", " of \\(engines.count) signed in\"",
            "\"Install \\(RunnerPageFormat.engineName(engine))\"").forEach { assertTrue("$it is not in the Swift sources", source.contains(it)) }
        val settings = read("${kit}SettingsHome.swift")
        listOf("\"1 needs you\"", " need you\"").forEach { assertTrue("$it is not in SettingsHome.swift", settings.contains(it)) }
        // Settings' Machines group is headed "Machines", as on iOS, over the machines themselves; Providers' one row says its name.
        assertTrue("iOS heads Machines", settings.contains("case .machines:  return MachinesAndModels.machines"))
        assertTrue("iOS heads Providers", settings.contains("case .providers: return nil"))
        assertTrue(read("${views}SkillsRunnersView.swift").contains("failedTitle: \"Machines couldn't be loaded\""))
    }

    /** No product string points at the old Providers page: it became Infrastructure on every client (web 33e0e2e09, iOS 5e75edbde). Comments
     * and code may still name the Swift types the words were ported from (ProvidersOverview). Two rows are named Providers: the Agent
     * form's SubAgents group's (docs/mocks/subagent/05.png), the providers SubAgents may use; and Settings' own, the pools' half of
     * Machines & models, as the web's Settings nav and iOS name it (docs/mocks/ios-settings-web-groups). */
    @Test fun noProductStringSaysProviders() {
        // Unrolled, not `"(?:[^"\\\n]|\\.)*"`: that alternation recurses once per character in java.util.regex and
        // overflows the stack on a long literal (ProviderMark.kt's SVG paths). The same strings match.
        val literal = Regex("\"[^\"\\\\\\n]*(?:\\\\.[^\"\\\\\\n]*)*\"")
        val found = listOf("app", "core").flatMap { module ->
            File(root, "src/android/$module/src/main").walk().filter { it.extension == "kt" }.toList().flatMap { file ->
                file.readLines().withIndex().filterNot { (_, line) -> line.trimStart().let { it.startsWith("*") || it.startsWith("/*") || it.startsWith("//") } }
                    .flatMap { (index, line) -> literal.findAll(line).filter { "Providers" in it.value }.map { "${file.name}:${index + 1} ${it.value}" }.toList() }
            }
        }
        // `subagentBlockedProviders` is the preferences field's wire name, never shown.
        assertEquals(emptyList<String>(), found.filterNot { it.endsWith(" \"subagentBlockedProviders\"") } -
            setOf("Subagents.kt:${row("Subagents.kt", "const val PROVIDERS = \"Providers\"")} \"Providers\"",
                "SettingsScreen.kt:${row("SettingsScreen.kt", "const val SETTINGS_PROVIDERS = \"Providers\"")} \"Providers\""))
    }

    private fun row(file: String, line: String) = File(root, "src/android/app/src/main/kotlin/io/orbitd/android/management/$file").readLines()
        .indexOfFirst { it.contains(line) } + 1

    @Test fun theAntigravityRepairCardSaysMachinesAndModelsAsIosDoes() {
        val engineAuth = read("${kit}EngineAuth.swift")
        listOf(AntigravityRepair.NEEDS_KEY.body("wikova", "0.1.230"), AntigravityRepair.NOT_INSTALLED.body("wikova", null)).forEach {
            assertTrue("\"$it\" is not in EngineAuth.swift", engineAuth.contains("\"$it\""))
        }
        assertTrue("the card's way to the engine page", read("${views}RunnerSignInView.swift").contains("Button(\"Open in Machines & models\")"))
    }

    @Test fun aSharedPoolsPeopleSeeItOnTheirMachinesAndModelsPage() {
        val source = read("${kit}WhoCanUseIt.swift")
        val pool = Json.parseToJsonElement("""{"id":"p","label":"Team Codex","keys":[],
            "people":[{"userId":"a","name":"Me","creator":true,"you":true},{"userId":"b","name":"Bo"}]}""").jsonObject
        assertEquals("They see Team Codex on their Machines & models page and in the session picker.", WhoCanUseIt(pool, 0).modeHint)
        assertTrue(source.contains("\"They see \\(label) on their Machines & models page and in the session picker.\""))
        val seen = SharePool.facts(pool, 0).first()
        assertEquals("They see Team Codex", seen.lead)
        assertTrue("\"${seen.rest}\" is not in WhoCanUseIt.swift", source.contains("rest: \"${seen.rest}\""))
    }
}

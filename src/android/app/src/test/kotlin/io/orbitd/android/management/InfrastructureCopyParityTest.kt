package io.orbitd.android.management

import io.orbitd.android.core.cards.AntigravityRepair
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Infrastructure page's words are iOS's (5e75edbde), byte for byte, and so is what sends a reader there (39f906344): the Antigravity
 * repair card, and where the people of a shared pool see it. No product string still points at a Providers page. */
class InfrastructureCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).readText()
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    private fun constants(holder: Any): Map<String, String> = holder.javaClass.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(holder) }.getOrNull() as? String)?.let { field.name to it }
    }.toMap()

    /** Every constant of Infrastructure is a literal in the Swift it was ported from: Infrastructure and ProvidersOverview, the page's
     * name (AppSection), and the engine page's install words (RunnerEnginePage). */
    @Test fun infrastructureWordsAreIosOwn() {
        val source = listOf("${kit}Infrastructure.swift", "${kit}ProvidersOverview.swift", "${kit}AppSection.swift", "${views}RunnerEnginePage.swift")
            .joinToString("\n") { read(it) }
        val words = constants(Infrastructure)
        assertTrue("Infrastructure holds no words", words.size >= 15)
        assertEquals("Infrastructure strings not in the Swift sources", emptyMap<String, String>(), words.filterValues { !source.contains("\"$it\"") })
        // The sentences built around a name keep iOS's words around it.
        listOf("\"\\(machine) is offline\"", "\"\\(machine) has no coding CLI signed in\"",
            "\"Last seen \\(", "\"Never checked in\"", "\" · its subscriptions are unavailable until it’s back\"", "\"\\(pool) is unavailable\"",
            "\"\\(reason) · no session can start on it\"", " · \\(busy) / \\(all) slots busy\"", "\"\\(active) / \\(max) running\"",
            "\"Install failed\"", "\"Update failed\"", "\"Updating…\"",
            "\"Engines not reported\"", "\"1 engine not updating\"", "\"All signed in\"", " of \\(engines.count) signed in\"",
            "\"Install \\(RunnerPageFormat.engineName(engine))\"").forEach { assertTrue("$it is not in the Swift sources", source.contains(it)) }
        val settings = read("${kit}SettingsHome.swift")
        listOf("\"1 needs you\"", " need you\"").forEach { assertTrue("$it is not in SettingsHome.swift", settings.contains(it)) }
        // Settings' Machines & models group has no header, as on iOS: its one row says the name.
        assertTrue("iOS heads Machines & models", settings.contains("case .machines:    return nil"))
        assertTrue(read("${views}SkillsRunnersView.swift").contains("failedTitle: \"Machines couldn't be loaded\""))
    }

    /** No product string points at a Providers page: it became Infrastructure on every client (web 33e0e2e09, iOS 5e75edbde). Comments and
     * code may still name the Swift types the words were ported from (ProvidersOverview). */
    @Test fun noProductStringSaysProviders() {
        val literal = Regex("\"(?:[^\"\\\\\\n]|\\\\.)*\"")
        val found = listOf("app", "core").flatMap { module ->
            File(root, "src/android/$module/src/main").walk().filter { it.extension == "kt" }.toList().flatMap { file ->
                file.readLines().withIndex().filterNot { (_, line) -> line.trimStart().let { it.startsWith("*") || it.startsWith("/*") || it.startsWith("//") } }
                    .flatMap { (index, line) -> literal.findAll(line).filter { "Providers" in it.value }.map { "${file.name}:${index + 1} ${it.value}" }.toList() }
            }
        }
        assertEquals(emptyList<String>(), found)
    }

    @Test fun theAntigravityRepairCardSaysInfrastructureAsIosDoes() {
        val engineAuth = read("${kit}EngineAuth.swift")
        listOf(AntigravityRepair.NEEDS_KEY.body("wikova", "0.1.230"), AntigravityRepair.NOT_INSTALLED.body("wikova", null)).forEach {
            assertTrue("\"$it\" is not in EngineAuth.swift", engineAuth.contains("\"$it\""))
        }
        assertTrue("the card's way to the engine page", read("${views}RunnerSignInView.swift").contains("Button(\"Open in Machines & models\")"))
    }

    @Test fun aSharedPoolsPeopleSeeItOnTheirInfrastructurePage() {
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

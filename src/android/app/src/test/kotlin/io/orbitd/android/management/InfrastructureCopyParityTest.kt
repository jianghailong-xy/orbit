package io.orbitd.android.management

import io.orbitd.android.core.cards.AntigravityRepair
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** What sends a reader to Infrastructure says what iOS says (39f906344), byte for byte: the Antigravity repair card, and where the
 * people of a shared pool see it. */
class InfrastructureCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).readText()
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    @Test fun theAntigravityRepairCardSaysInfrastructureAsIosDoes() {
        val engineAuth = read("${kit}EngineAuth.swift")
        listOf(AntigravityRepair.NEEDS_KEY.body("wikova", "0.1.230"), AntigravityRepair.NOT_INSTALLED.body("wikova", null)).forEach {
            assertTrue("\"$it\" is not in EngineAuth.swift", engineAuth.contains("\"$it\""))
        }
        assertTrue("the card's way to the engine page", read("${views}RunnerSignInView.swift").contains("Button(\"Open in Infrastructure\")"))
    }

    @Test fun aSharedPoolsPeopleSeeItOnTheirInfrastructurePage() {
        val source = read("${kit}WhoCanUseIt.swift")
        val pool = Json.parseToJsonElement("""{"id":"p","label":"Team Codex","keys":[],
            "people":[{"userId":"a","name":"Me","creator":true,"you":true},{"userId":"b","name":"Bo"}]}""").jsonObject
        assertEquals("They see Team Codex on their Infrastructure page and in the session picker.", WhoCanUseIt(pool, 0).modeHint)
        assertTrue(source.contains("\"They see \\(label) on their Infrastructure page and in the session picker.\""))
        val seen = SharePool.facts(pool, 0).first()
        assertEquals("They see Team Codex", seen.lead)
        assertTrue("\"${seen.rest}\" is not in WhoCanUseIt.swift", source.contains("rest: \"${seen.rest}\""))
    }
}

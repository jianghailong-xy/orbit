package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The Settings maintenance card's repository part (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤), held to
 * `src/shared/src/wiki-repo-card.fixture.json` — the file the web's `lib/wikiRepoCard.test.ts` and OrbitKit's
 * `WikiRepoCardParityTests` read too: each case's tag, tone, line, whether a run may be asked for and why not, and
 * whether Use this folder is offered; plus the buttons' and the confirmation's words. */
class WikiRepoCardTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "src/shared/src/wiki-repo-card.fixture.json") }
            .first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
    private val now get() = RelativeTime.parse(fixture.string("now"))!!

    @Test fun everyCaseSaysTheFixturesCard() {
        val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 10)
        cases.forEach { case ->
            val name = case.string("name")
            val card = WikiRepoCardLogic.card(WikiSpaceHealth.decode(case.getValue("health")), now)
            val want = case["card"] as? JsonObject
            if (want == null) { assertNull(name, card); return@forEach }
            assertNotNull(name, card)
            val tag = want.getValue("tag").jsonObject
            assertEquals(name, tag.string("text"), card!!.tag)
            assertEquals("$name: tone", tag.string("tone"), card.tone.name.lowercase())
            assertEquals("$name: line", want.string("line"), card.line)
            assertEquals("$name: canRun", want.getValue("canRun").jsonPrimitive.boolean, card.canRun)
            assertEquals("$name: blocked", want["blocked"]?.jsonPrimitive?.contentOrNull, card.blocked)
            assertEquals("$name: useFolder", want.getValue("useFolder").jsonPrimitive.boolean, card.useFolder)
        }
    }

    @Test fun theButtonsAndTheConfirmationAreTheFixturesWords() {
        val copy = fixture.getValue("copy").jsonObject
        assertEquals(copy.string("checkAndRun"), WikiRepoCardCopy.checkAndRun)
        assertEquals(copy.string("changeWorkspace"), WikiRepoCardCopy.changeWorkspace)
        assertEquals(copy.string("useFolder"), WikiRepoCardCopy.useFolder)
        assertEquals(copy.string("useFolderTitle"), WikiRepoCardCopy.useFolderTitle)
        assertEquals(copy.string("useFolderNote"), WikiRepoCardCopy.useFolderNote)
        assertEquals(copy.string("dailyLimit"), WikiRepoCardCopy.dailyLimit)
        assertEquals(copy.string("runUnderWay"), WikiRepoCardCopy.runUnderWay)
        assertEquals(copy.string("runStarted"), WikiRepoCardCopy.runStarted)
        assertEquals(copy.string("runRefused"), WikiRepoCardCopy.runRefused)
        assertEquals(copy.string("probeChecking"), WikiRepoCardCopy.probeChecking)
        assertEquals(copy.string("probeFailed"), WikiRepoCardCopy.probeFailed)
    }

    @Test fun theProbeAnswerReadsAsTheServerWritesIt() {
        val answer = WikiRepoProbeAnswer.read(Wire.json.parseToJsonElement(
            """{"workspaceId":"w","tier":"wrong_repository","reason":"wrong_repository","origin":null,"tone":"wrong","title":"~/work/app is a clone of github.com/x/y, not this wiki's repository","note":null,"canTurnOn":false,"checkedAt":"2026-11-11T00:00:00.000Z"}"""))
        assertEquals("wrong", answer!!.tone)
        assertFalse(answer.canTurnOn)
    }
}

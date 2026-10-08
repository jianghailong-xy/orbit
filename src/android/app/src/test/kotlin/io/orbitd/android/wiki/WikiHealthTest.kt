package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiHealthCopyParityTests`' fixture cases (src/shared/src/wiki-health.fixture.json, which the web's
 * tests read too): each health read's parts — text, tone, mark, link, weight — its text, and the whole line under
 * the home's title; plus the web's `wikiAgo`/`wikiLag` times. The web-source declaration checks are Swift's. */
class WikiHealthTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "src/shared/src/wiki-health.fixture.json") }
            .first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun JsonElement.string(key: String) = jsonObject.getValue(key).jsonPrimitive.content
    private val now get() = RelativeTime.parse(fixture.string("now"))!!

    @Test fun everyLookSaysTheFixturesWords() {
        val shared = fixture.getValue("space").jsonObject
        val space = WikiSpace(shared.getValue("id").jsonPrimitive.content, shared.getValue("slug").jsonPrimitive.content,
            rootCommitSha = shared["rootCommitSha"]?.jsonPrimitive?.contentOrNull, pendingOps = shared["pendingOps"]?.jsonPrimitive?.intOrNull)
        val cases = fixture.getValue("cases").jsonArray
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = case.string("name")
            val health = WikiSpaceHealth.decode(case.jsonObject.getValue("health"))
            // The whole maintenance part: the look's parts, and — while the server runs the wiki — its reason (P9).
            val parts = WikiHealthLogic.parts(health, now)
            if (!health.serverExecutes) assertEquals("$name: runner says the look alone", WikiHealthLogic.parts(health.maintenance, now), parts)
            val expected = case.jsonObject.getValue("parts").jsonArray.map { it.jsonObject }
            assertEquals(name, expected.map { it.string("text") }, parts.map { it.text })
            assertEquals("$name: tones", expected.map { it.string("tone") }, parts.map { it.tone.name.lowercase() })
            assertEquals("$name: marks", expected.map { it.string("mark") }, parts.map { it.mark.name.lowercase() })
            assertEquals("$name: links", expected.map { it.string("link") }, parts.map { it.link.name.lowercase() })
            assertEquals("$name: weight", expected.map { it.getValue("strong").jsonPrimitive.boolean }, parts.map { it.strong })
            assertEquals(name, case.string("text"), WikiHealthLogic.text(parts))
            // The whole line under the title: every active entry the read counts, the anchors, then maintenance.
            val home = WikiHomeContent(space, listOf(space), emptyList(), emptyList(), space.pendingOps ?: 0, health = health)
            assertEquals("$name: the line under the title", case.string("line"), home.statusLine(now))
        }
    }

    @Test fun noHealthReadAndAnUnknownLookDrawNothingOfMaintenance() {
        val shared = fixture.getValue("space").jsonObject
        val space = WikiSpace(shared.getValue("id").jsonPrimitive.content, shared.getValue("slug").jsonPrimitive.content,
            rootCommitSha = shared["rootCommitSha"]?.jsonPrimitive?.contentOrNull)
        assertEquals("0 entries · Anchors verified at 1588c3b", WikiHomeContent(space, listOf(space), emptyList(), emptyList(), 0).statusLine(now))
        val later = WikiSpaceHealth.decode(Wire.json.parseToJsonElement("""{"spaceId":"s","entries":3,"maintenance":{"look":"paused","enabled":true}}"""))
        assertEquals("a key a server one release apart left out reads as its default", 0, later.maintenance.backlog)
        assertEquals(emptyList<WikiStatusPart>(), WikiHealthLogic.parts(later.maintenance, now))
        assertEquals("3 entries · Anchors verified at 1588c3b",
            WikiHomeContent(space, listOf(space), emptyList(), emptyList(), 0, health = later).statusLine(now))
    }

    @Test fun theTimesReadAsTheWebReadsThem() {
        val now = Instant.parse("2026-09-28T12:00:00Z")
        fun at(minutes: Double) = now.minusMillis((minutes * 60_000).toLong()).toString()
        assertEquals("just now", WikiHealthLogic.ago(at(0.5), now))
        assertEquals("4m ago", WikiHealthLogic.ago(at(4.0), now))
        assertEquals("2h ago", WikiHealthLogic.ago(at(125.0), now))
        assertEquals("1d ago", WikiHealthLogic.ago(at(25.0 * 60), now))
        assertEquals("2w ago", WikiHealthLogic.ago(at(15.0 * 24 * 60), now))
        assertEquals("just now", WikiHealthLogic.ago(at(-3.0), now))
        assertEquals("just now", WikiHealthLogic.ago("", now))
        assertEquals("40m", WikiHealthLogic.lag(40 * 60))
        assertEquals("26h", WikiHealthLogic.lag(26 * 3600))
        assertEquals("71h", WikiHealthLogic.lag(71 * 3600 + 59 * 60))
        assertEquals("3d", WikiHealthLogic.lag(72 * 3600))
        assertEquals("14d", WikiHealthLogic.lag(14 * 86_400))
        assertEquals("Maintenance failed", WikiHealthCopy.failed(1))
        assertEquals("Maintenance failed 3 times", WikiHealthCopy.failed(3))
        assertEquals("View run", WikiModeCopy.viewRun)
    }
}

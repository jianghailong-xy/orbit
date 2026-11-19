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
            if (!health.serverExecutes) assertEquals("$name: a read without the executor says the look alone", WikiHealthLogic.parts(health.maintenance, now), parts)
            assertParts(name, case.jsonObject.getValue("parts").jsonArray, parts)
            assertEquals(name, case.string("text"), WikiHealthLogic.text(parts))
            // A phone's line: the repository's short words, and the whole line under the title ends with it.
            val narrow = WikiHealthLogic.parts(health, now, narrow = true)
            assertParts("$name (narrow)", case.jsonObject.getValue("narrowParts").jsonArray, narrow)
            assertEquals("$name (narrow)", case.string("narrowText"), WikiHealthLogic.text(narrow))
            assertTrue("$name: the line ends with the phone's text", case.string("line").endsWith(" · ${case.string("narrowText")}"))
            // The whole line under the title — a phone's: every active entry the read counts, the anchors, then maintenance.
            val home = WikiHomeContent(space, listOf(space), emptyList(), emptyList(), health = health)
            assertEquals("$name: the line under the title", case.string("line"), home.statusLine(now))
        }
    }

    private fun assertParts(name: String, expected: JsonArray, parts: List<WikiStatusPart>) {
        val rows = expected.map { it.jsonObject }
        assertEquals(name, rows.map { it.string("text") }, parts.map { it.text })
        assertEquals("$name: tones", rows.map { it.string("tone") }, parts.map { it.tone.name.lowercase() })
        assertEquals("$name: marks", rows.map { it.string("mark") }, parts.map { it.mark.name.lowercase() })
        assertEquals("$name: links", rows.map { it.string("link") }, parts.map { it.link.name.lowercase() })
        assertEquals("$name: weight", rows.map { it.getValue("strong").jsonPrimitive.boolean }, parts.map { it.strong })
        assertEquals("$name: hints", rows.map { it["hint"]?.jsonPrimitive?.contentOrNull }, parts.map { it.hint })
    }

    private val cases get() = fixture.getValue("cases").jsonArray.map { it.jsonObject }
    private fun health(case: JsonObject) = WikiSpaceHealth.decode(case.getValue("health"))
    private fun byTier(tier: String) = cases.map(::health).first { it.repo?.tier == tier && it.maintenance.look == "ok" }

    @Test fun theFixtureCoversEveryRepositoryTier() {
        assertEquals(setOf("git", "folder", "sessions", "wrong_repository"), cases.mapNotNull { health(it).repo?.tier }.toSet())
    }

    /** Design §7.2, mock 44 ⑤: nothing on git; the folder grey to Settings, its cost in the hint; amber while the code
     * checks wait, red for another repository's folder or a refused credential, Fix in Settings last. */
    @Test fun theRepositoryPartSaysTheTier() {
        val git = byTier("git")
        assertEquals(emptyList<WikiStatusPart>(), WikiHealthLogic.repoParts(git, false))
        assertEquals(WikiHealthLogic.parts(git.maintenance, now), WikiHealthLogic.parts(git, now))

        assertEquals(listOf(WikiStatusPart("Reading the folder, not git", WikiStatusPart.Tone.MUTED, link = WikiStatusPart.Link.SETTINGS,
            hint = "Commit anchors are not checked: ~/work/app is not a git checkout.")), WikiHealthLogic.repoParts(byTier("folder"), false))
        assertEquals(listOf("Reading the folder"), WikiHealthLogic.repoParts(byTier("folder"), true).map { it.text })

        val sessions = WikiHealthLogic.parts(byTier("sessions"), now)
        assertEquals(WikiStatusPart("Code checks paused: ~/work/app was not found on MacBook", WikiStatusPart.Tone.WARN,
            WikiStatusPart.Mark.DOT, strong = true), sessions[sessions.size - 2])
        assertEquals(WikiStatusPart(WikiHealthCopy.repoFix, link = WikiStatusPart.Link.SETTINGS), sessions.last())
        val wrong = WikiHealthLogic.parts(byTier("wrong_repository"), now)
        assertEquals("~/work/app is a clone of github.com/x/y, not this wiki's repository", wrong[wrong.size - 2].text)
        assertEquals(WikiStatusPart.Tone.ERROR, wrong[wrong.size - 2].tone)
        val refused = cases.map(::health).first { it.repo?.reason == "fetch_refused" }
        assertEquals(WikiStatusPart.Tone.ERROR, WikiHealthLogic.repoParts(refused, false).first().tone)
        // Fix in Settings goes after the look's own link: View run stays where the look puts it.
        val failing = cases.map(::health).first { it.repo?.tier == "sessions" && it.maintenance.look == "failing" }
        assertEquals(listOf("Code checks paused: ~/work/app was not found on MacBook", "View run", WikiHealthCopy.repoFix),
            WikiHealthLogic.parts(failing, now).map { it.text }.takeLast(3))

        // A phone says the short words alone; nothing while maintenance is off.
        assertEquals(listOf("Code checks paused"), WikiHealthLogic.repoParts(byTier("sessions"), true).map { it.text })
        assertEquals(listOf("Wrong folder"), WikiHealthLogic.repoParts(byTier("wrong_repository"), true).map { it.text })
        val off = byTier("sessions").let { it.copy(maintenance = it.maintenance.copy(enabled = false)) }
        assertEquals(emptyList<WikiStatusPart>(), WikiHealthLogic.repoParts(off, false))
    }

    /** The offline runner is said once: as the reason the code checks wait, not again as the server's reason. */
    @Test fun theOfflineRunnerIsSaidOnce() {
        val offline = cases.map(::health).first { it.repo?.tier == "sessions" && it.repo?.reason == "runner_offline" }
        assertNull(WikiHealthLogic.serverReason(offline))
        assertEquals(1, Regex("Waiting for the runner to come online").findAll(WikiHealthLogic.text(WikiHealthLogic.parts(offline, now))).count())
    }

    /** A read from a control plane older than the tiers names none, and the line says nothing of the repository. */
    @Test fun aReadWithoutATierSaysNothingOfTheRepository() {
        val read = WikiSpaceHealth.decode(Wire.json.parseToJsonElement("""{"spaceId":"s","entries":3,"maintenance":{"look":"ok","enabled":true},
            "repo":{"look":"ready","pending":0}}"""))
        assertNull(read.repo?.tier)
        assertEquals(emptyList<WikiStatusPart>(), WikiHealthLogic.repoParts(read, false))
    }

    @Test fun noHealthReadAndAnUnknownLookDrawNothingOfMaintenance() {
        val shared = fixture.getValue("space").jsonObject
        val space = WikiSpace(shared.getValue("id").jsonPrimitive.content, shared.getValue("slug").jsonPrimitive.content,
            rootCommitSha = shared["rootCommitSha"]?.jsonPrimitive?.contentOrNull)
        assertEquals("0 entries · Anchors verified at 1588c3b", WikiHomeContent(space, listOf(space), emptyList(), emptyList()).statusLine(now))
        val later = WikiSpaceHealth.decode(Wire.json.parseToJsonElement("""{"spaceId":"s","entries":3,"maintenance":{"look":"paused","enabled":true}}"""))
        assertEquals("a key a server one release apart left out reads as its default", 0, later.maintenance.backlog)
        assertEquals(emptyList<WikiStatusPart>(), WikiHealthLogic.parts(later.maintenance, now))
        assertEquals("3 entries · Anchors verified at 1588c3b",
            WikiHomeContent(space, listOf(space), emptyList(), emptyList(), health = later).statusLine(now))
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

    /** With maintenance off, a read of the repository that waits still says the runner: the case the fixture's
     * "nothing waits on the offline runner" leaves out. A read one release apart is `WikiServerExecutionFixtureTest`'s. */
    @Test fun aWaitingReadSaysTheRunnerWithMaintenanceOff() {
        val waiting = WikiSpaceHealth.decode(Wire.json.parseToJsonElement("""{"spaceId":"s","entries":3,"maintenance":{"look":"off","enabled":false},
            "repo":{"look":"runner_offline","pending":1},"executor":{"mode":"server","serverExecutes":true},"systemModel":{"state":"up"}}"""))
        assertEquals("Maintenance off · ● Waiting for the runner to come online · Set up", WikiHealthLogic.text(WikiHealthLogic.parts(waiting, now)))
    }

    /** The server's reasons are said only while the read says the server executes the account's wiki: the fixture's
     * offline runner, read without its executor, says no reason — the look alone. */
    @Test fun aReadThatDoesNotSayTheServerExecutesSaysNoReason() {
        val case = fixture.getValue("cases").jsonArray.map { it.jsonObject }
            .first { it.string("name") == "server: maintained, and the runner the repository is read through is offline" }
        val said = WikiSpaceHealth.decode(case.getValue("health"))
        assertNotNull(WikiHealthLogic.serverReason(said))
        val health = WikiSpaceHealth.decode(JsonObject(case.getValue("health").jsonObject - "executor"))
        assertFalse(health.serverExecutes)
        assertNull(WikiHealthLogic.serverReason(health))
        assertEquals(WikiHealthLogic.parts(health.maintenance, now), WikiHealthLogic.parts(health, now))
    }
}

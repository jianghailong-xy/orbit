package io.orbitd.android.wiki

import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiServerExecutionCopyParityTests`' fixture half (src/shared/src/wiki-server-execution.fixture.json,
 * which the web's `lib/wikiRuns.test.ts` reads too): the runs' rows and their call logs, the System model's five
 * states and the settings page's server words, and the plan's sentences while the server drafts — plus the reads held
 * to `contracts/wiki.contract.json` (`jobs.read`, `jobs.executor.read`, `systemModel.read`). The web-source
 * declaration checks are Swift's. */
class WikiServerExecutionFixtureTest {
    private val shared get() = WikiSharedFiles.serverExecution
    private val now: Instant get() = RelativeTime.parse(shared.fstr("now"))!!

    private fun JsonElement.string(key: String) = jsonObject.getValue(key).jsonPrimitive.content
    private fun JsonElement.stringOrNull(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    // MARK: the settings page under server execution

    @Test fun theSettingsAndTheSystemModelSayTheFixturesWords() {
        val settings = shared.fobj("settings")
        assertEquals(settings.fstrings("rows"),
            listOf(WikiModeCopy.status, WikiModeCopy.repoFrom, WikiModeCopy.model, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        val fields = settings.fobj("form").farr("fields").map { it.jsonObject }
        assertEquals(settings.fstr("systemModel"), WikiRunsCopy.systemModel)
        assertEquals(fields.map { it.string("label") },
            listOf(WikiModeCopy.repoFrom, WikiModeCopy.model, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        assertEquals(fields.map { it.string("note") },
            listOf(WikiModeCopy.repoFromNote, WikiModeCopy.modelNote, WikiModeCopy.dailyLimitNote, WikiModeCopy.lookbackNote))
        assertEquals(settings.fstr("maintenanceNote"), WikiModeCopy.maintenanceNoteServer)
        assertEquals(settings.fstr("privacy"), WikiModeCopy.privacyNote)

        // The System model's five states, as the settings page, Set up and the Runs band's head say them.
        val models = settings.farr("models").map { it.jsonObject }
        assertEquals(listOf("up", "down", "auth_failed", "unconfigured", "worker_not_running"),
            models.map { it.fobj("status").string("state") })
        models.forEach { row ->
            val state = row.fobj("status").string("state")
            assertEquals(state, row.string("label"), WikiRunsCopy.systemModelLabel(row.fobj("status").stringOrNull("model")))
            assertEquals(state, row.string("state"), WikiRunsCopy.modelState(state))
            assertEquals(state, row.string("tone"), WikiRunsLogic.modelTone(state).name.lowercase())
        }
    }

    // MARK: the runs

    @Test fun everyRunRowSaysTheFixturesWords() {
        val runs = shared.fobj("runs")
        assertEquals(runs.fstr("title"), WikiRunsCopy.runs)
        assertEquals(runs.fstr("none"), WikiRunsCopy.none)
        val cases = runs.farr("cases").map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = case.string("name")
            val job = WikiJob.read(case["job"])!!
            val row = WikiRunsLogic.row(job, now)
            assertEquals("$name: kind", case.string("kind"), row.kind)
            assertEquals("$name: mark", case.string("mark"), row.mark.name.lowercase())
            assertEquals("$name: tone", case.string("tone"), row.tone.name.lowercase())
            assertEquals("$name: state", case.string("state"), row.state)
            assertEquals("$name: text", case.string("text"), row.text)
            assertEquals("$name: when", case.string("when"), row.whenText)
            assertEquals("$name: foot", case.string("foot"), WikiRunsLogic.foot(job))
        }
    }

    @Test fun everyCallRowSaysTheFixturesWords() {
        val runs = shared.fobj("runs")
        assertEquals(runs.fstr("callsTitle"), WikiRunsCopy.callsTitle)
        assertEquals(runs.fstrings("columns"),
            listOf(WikiRunsCopy.call, WikiRunsCopy.callState, WikiRunsCopy.callWaited, WikiRunsCopy.callRan, WikiRunsCopy.callTokens))
        runs.farr("durations").map { it.jsonObject }.forEach { row ->
            assertEquals("${row.fint("seconds")}s", row.string("says"), WikiRunsLogic.duration(row.fint("seconds").toDouble()))
        }
        val cases = runs.farr("calls").map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = case.string("name")
            val call = WikiJobCall.read(case["call"])!!
            val row = WikiRunsLogic.callRow(call, now)
            val expected = case.fobj("row")
            assertEquals("$name: call", expected.string("call"), row.call)
            assertEquals("$name: state", expected.string("state"), row.state)
            assertEquals("$name: retries", expected.stringOrNull("retries"), row.retries)
            assertEquals("$name: tone", expected.string("tone"), row.tone.name.lowercase())
            assertEquals("$name: waited", expected.string("waited"), row.waited)
            assertEquals("$name: ran", expected.string("ran"), row.ran)
            assertEquals("$name: tokens", expected.string("tokens"), row.tokens)
            assertEquals("$name: line", expected.string("line"), row.line)
            assertEquals("$name: error", expected.stringOrNull("error"), row.error)
        }
    }

    // MARK: the plan while the server drafts

    @Test fun thePlanNamesTheSystemModelWhileTheServerDrafts() {
        val plan = shared.fobj("plan")
        assertEquals(plan.fstr("drafter"), WikiPlanCopy.drafterServer)
        // Activity's Plan card: the short line beside Draft plan.
        assertEquals(plan.fstr("note"), WikiPlanCopy.noteServer)
        // The plan's empty page: the note says where a draft runs, and the body names the System model.
        assertEquals(plan.fstr("emptyNote"), WikiPlanCopy.emptyNoteServer)
        assertEquals(plan.fstr("emptyText"), WikiPlanCopy.emptyText)
        val notes = plan.farr("redraftNotes").map { it.jsonObject }
        assertEquals(3, notes.size)
        notes.forEach { row ->
            val from = row["from"]?.takeIf { it !is JsonNull }?.jsonObject
                ?.let { it.fint("version") to it.getValue("inForce").jsonPrimitive.boolean }
            assertEquals(row.string("says"), WikiPlanCopy.redraftNote(from))
        }
        // What is drafting: the job's card names the System model too.
        val drafting = WikiPlanJob.read(Json.parseToJsonElement(
            """{"id":"job-drafting","kind":"draft","state":"running","provider":null,"attempt":1,"attemptsMax":3}"""))
        val card = WikiPlanLogic.jobCard(drafting, Instant.now(), true, null, false, null)!!
        assertTrue("the drafting card names the System model: ${card.text}", card.text.startsWith("${plan.fstr("drafter")} · "))
    }

    // MARK: the reads are the contracts

    @Test fun theReadsAreTheContracts() {
        val contract = WikiSharedFiles.contract
        val jobs = contract.fobj("jobs")
        val read = jobs.fobj("read")
        assertEquals("GET /api/wiki/spaces/:id/jobs", read.fstr("route"))
        assertEquals(jobs.fstrings("kinds"), shared.fobj("runs").fobj("kinds").keys.toList())
        jobs.fstrings("kinds").forEach { assertEquals(shared.fobj("runs").fobj("kinds").fstr(it), WikiRunsCopy.kind(it)) }
        assertEquals(jobs.fstrings("states"), listOf("queued", "running", "waiting", "succeeded", "failed", "cancelled"))
        // Every state a run can be in is a case of the fixture, and every call state too.
        assertEquals(jobs.fstrings("states").toSet(),
            shared.fobj("runs").farr("cases").map { it.jsonObject.fobj("job").string("state") }.toSet())
        assertEquals(contract.fobj("modelQueue").fstrings("states").toSet(),
            shared.fobj("runs").farr("calls").map { it.jsonObject.fobj("call").string("state") }.toSet())
        assertEquals(read.fobj("limits").fint("jobs"), 10)
        assertEquals(read.fobj("limits").fint("callsPerJob"), 40)
        // The executor's read: the mode and whether the server runs this account's wiki.
        assertEquals(jobs.fobj("executor").fstrings("modes"), listOf("runner", "canary", "server"))
        // The System model's read: its states, and its fields — never its address or its key.
        val model = contract.fobj("systemModel").fobj("read")
        assertEquals(model.fstrings("states"), listOf("up", "down", "auth_failed", "unconfigured", "worker_not_running"))
        assertEquals(model.fstrings("fields"), listOf("state", "model", "since", "checkedAt", "workerSeenAt", "executor"))
        // A read one release apart: an older control plane sends no executor and no new fields — the server's reason
        // is then not said.
        val older = WikiSpaceHealth.decode(Json.parseToJsonElement("""{"spaceId":"s","entries":3,"maintenance":{"look":"ok","enabled":true}}"""))
        assertFalse(older.serverExecutes)
        assertNull(older.systemModel)
        assertNull(WikiHealthLogic.serverReason(older))
        val unknown = WikiJob.read(Json.parseToJsonElement("""{"id":"j","kind":"later","state":"paused","createdAt":"a"}"""))!!
        assertEquals("later", unknown.kind)
        assertEquals("paused", unknown.state)
        assertEquals("", WikiRunsCopy.kind(unknown.kind))
        assertEquals(0, unknown.calls.total)
    }
}

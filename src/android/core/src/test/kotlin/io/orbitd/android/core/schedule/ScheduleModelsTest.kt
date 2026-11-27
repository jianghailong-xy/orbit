package io.orbitd.android.core.schedule

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The schedule shapes read leniently, as OrbitKit's decoders read them, and the REST doors each press. */
class ScheduleModelsTest {
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test fun ruleKindsReadAndWrite() {
        assertEquals(ScheduleRule.Once("2026-11-14T18:00"), ScheduleRule.parse(json("""{"kind":"ONCE","at":"2026-11-14T18:00"}""")))
        assertEquals(ScheduleRule.Daily("10:00"), ScheduleRule.parse(json("""{"kind":"DAILY","time":"10:00"}""")))
        assertEquals(ScheduleRule.Weekly("09:00", listOf("MON", "FRI")),
            ScheduleRule.parse(json("""{"kind":"WEEKLY","time":"09:00","weekdays":["MON","FRI"]}""")))
        // Any other kind is weekly; weekdays that do not read are none.
        assertEquals(ScheduleRule.Weekly("09:00", emptyList()), ScheduleRule.parse(json("""{"kind":"MONTHLY","time":"09:00","weekdays":[1]}""")))
        assertNull(ScheduleRule.parse(json("""{"kind":"DAILY"}""")))
        assertNull(ScheduleRule.parse(json("""{"time":"10:00"}""")))
        for (rule in listOf(ScheduleRule.Once("x"), ScheduleRule.Daily("10:00"), ScheduleRule.Weekly("09:00", listOf("MON")))) {
            assertEquals(rule, ScheduleRule.parse(rule.toJson()))
        }
        assertEquals("""{"kind":"WEEKLY","time":"09:00","weekdays":["MON"]}""", ScheduleRule.Weekly("09:00", listOf("MON")).toJson().toString())
        assertNull(ScheduleRule.Once("x").time)
    }

    @Test fun aScheduleTakesTheSwiftDefaults() {
        val s = ScheduleView.parse(json("""{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"workspaceId":"w"}"""))!!
        assertEquals("UTC", s.timezone)
        assertEquals("CHECK_ONLY", s.accessLevel)
        assertEquals(30, s.runLimitMinutes)
        assertEquals(7, s.runsPerWeek)
        assertEquals(ScheduleEnvelope("w", "CHECK_ONLY", 7, 30), s.envelope)
        assertEquals("ACTIVE", s.state)
        assertEquals(1, s.revision)
        assertEquals(0, s.consecutiveFailures)
        assertEquals("", s.createdAt)
        assertEquals("", s.intent)
        // A required field missing, or the wrong type, makes the row unreadable.
        assertNull(ScheduleView.parse(json("""{"id":"a","title":"A","workspaceId":"w"}""")))
        assertNull(ScheduleView.parse(json("""{"id":1,"title":"A","rule":{"kind":"DAILY","time":"09:00"},"workspaceId":"w"}""")))
        // A whole number written 7.0 is still 7; a string is not a number.
        val t = ScheduleView.parse(json("""{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"workspaceId":"w",
            "runsPerWeek":3.0,"runLimitMinutes":"45"}"""))!!
        assertEquals(3, t.runsPerWeek)
        assertEquals(30, t.runLimitMinutes)
    }

    @Test fun oneBadElementIsDroppedNeverTheList() {
        val detail = ScheduleDetailResponse.parse(json("""{"schedule":{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"workspaceId":"w"},
            "recentRuns":[{"id":"r1","scheduleId":"a","plannedAt":"p","state":"CHANGED"},{"id":"r2"}],
            "findings":[{"key":"k"},{"summary":"no key"}],
            "usage":{"runs":14,"minutes":41,"costUsd":1.5},
            "history":[{"scheduleId":"a","revision":2,"before":{"state":"ACTIVE"},"after":{"state":"PAUSED"},"undo":{"path":"/api/schedules/a/undo","body":{"revision":2}}},
                       {"scheduleId":"a"}],
            "pendingCards":[{"id":"c","kind":"UPDATE","envelope":{"widens":["ACCESS_LEVEL"],"now":null,
                "asked":{"runsIn":{"workspaceId":"w"},"may":{"accessLevel":"OPEN_PR"},"costs":{"runsPerWeek":7,"runLimitMinutes":30}}}},
                {"kind":"CREATE"}]}"""))!!
        assertEquals(listOf("r1"), detail.recentRuns.map { it.id })
        assertEquals("SCHEDULED", detail.recentRuns[0].trigger)
        assertEquals(1, detail.recentRuns[0].attempt)
        assertEquals(listOf("k"), detail.findings.map { it.key })
        assertEquals(ScheduleUsageView(null, 14, 41, 1.5), detail.usage)
        val record = detail.history.single()
        assertEquals("a@2", record.id)
        assertEquals("USER", record.changedBy)
        assertEquals(ScheduleUndoDoor("/api/schedules/a/undo", 2), record.undo)
        assertTrue(ScheduleDisplay.recordUndoable(record))
        assertEquals("Paused", ScheduleDisplay.recordText(record))
        val card = detail.pendingCards.single()
        assertEquals(ScheduleEnvelope("w", "OPEN_PR", 7, 30), card.envelope?.asked?.envelope)
        assertNull(card.envelope?.now)
        assertEquals("PENDING", card.state)
        assertNull(card.askedBy)
        assertNull(ScheduleDetailResponse.parse(json("""{"recentRuns":[]}""")))
        // The list itself must be there; its runs are optional.
        assertNull(ScheduleListResponse.parse(json("""{"runs":[]}""")))
    }

    @Test fun aWaitingItemOfAnotherKindIsNone() {
        assertNull(ScheduleWaitingItem.parse(json("""{"id":"o","kind":"DECISION","state":"PENDING","scheduleId":"S"}""")))
        assertNull(ScheduleWaitingItem.parse(json("""{"id":"o","kind":"SCHEDULE_HELD","state":"PENDING"}""")))
        val item = ScheduleWaitingItem.parse(json("""{"id":"o","kind":"SCHEDULE_WIDEN","state":"PENDING","scheduleId":"S",
            "scheduleChangeRequestId":"q"}"""))!!
        assertEquals("q", item.scheduleChangeRequestId)
        assertEquals("", item.title)
        assertEquals("", item.createdAt)
        assertEquals(ScheduleWaitingItem.KINDS, ScheduleWaitingItem.kinds)
    }

    @Test fun aChangeValueReadsAsText() {
        assertEquals("30", ScheduleDisplay.asString(JsonPrimitive(30)))
        assertEquals("abc", ScheduleDisplay.asString(JsonPrimitive("abc")))
        assertEquals("true", ScheduleDisplay.asString(JsonPrimitive(true)))
        assertNull(ScheduleDisplay.asString(json("null")))
        assertNull(ScheduleDisplay.asString(json("{}")))
        val after = buildJsonObject { put("runLimitMinutes", 45) }
        val before = buildJsonObject { put("runLimitMinutes", 30) }
        assertEquals("Run limit 30 min → 45 min", ScheduleDisplay.recordParts(2, before, after).text)
        assertEquals("Changed Codex stable check: run limit 30 min → 45 min",
            ScheduleDisplay.changeLineText("Codex stable check", 2, "USER", before, after))
        val ends = buildJsonObject { put("endAt", kotlinx.serialization.json.JsonNull) }
        assertEquals("Ends 2026-12-01T00:00:00.000Z → no end",
            ScheduleDisplay.recordParts(3, buildJsonObject { put("endAt", "2026-12-01T00:00:00.000Z") }, ends).text)
    }

    // The change conversation (§8.2)

    private val openingJson = """{"scheduleId":"a","title":"Codex stable check","revision":3,
        "does":"Check the Codex stable release against our pinned version","when":"Every day at 09:00 · Asia/Shanghai",
        "runsIn":"apiserver · Codex agent","may":"Check only · reads and reports, edits nothing","costs":"Up to 7 runs a week, 30 min each"}"""

    @Test fun aChangeConversationReadsItsOpeningAndItsAnswer() {
        val get = ScheduleChangeConversationResponse.parse(json("""{"sessionId":null,"opening":$openingJson}"""))!!
        assertNull(get.sessionId)
        val opening = get.opening
        assertEquals("a", opening.scheduleId)
        assertEquals("Codex stable check", opening.title)
        assertEquals(3, opening.revision)
        assertEquals("Every day at 09:00 · Asia/Shanghai", opening.`when`)
        assertEquals("Up to 7 runs a week, 30 min each", opening.costs)
        assertEquals("S9", ScheduleChangeConversationResponse.parse(json("""{"sessionId":"S9","opening":$openingJson}"""))!!.sessionId)
        // The opening is required; an opening this build cannot read is no answer.
        assertNull(ScheduleChangeConversationResponse.parse(json("""{"sessionId":null}""")))
        assertNull(ScheduleChangeConversationResponse.parse(json("""{"sessionId":null,"opening":{"title":"x"}}""")))
        // POST's answer: created, or found meanwhile (created=false — the words were said in the open one).
        assertEquals(ScheduleChangeAnswer("S9", true), ScheduleChangeAnswer.parse(json("""{"sessionId":"S9","created":true}""")))
        assertEquals(ScheduleChangeAnswer("S9", false), ScheduleChangeAnswer.parse(json("""{"sessionId":"S9","created":false}""")))
        assertNull(ScheduleChangeAnswer.parse(json("""{"created":true}""")))
    }

    @Test fun theOpeningsRowsAreTheContractsInOrder() {
        val opening = ScheduleChangeOpening.parse(json(openingJson))!!
        assertEquals(listOf("Does", "When", "Runs in", "May", "Costs"), scheduleChangeOpeningRows(opening).map { it.label })
        assertEquals(listOf(opening.does, opening.`when`, opening.runsIn, opening.may, opening.costs),
            scheduleChangeOpeningRows(opening).map { it.text })
    }

    @Test fun aRecordReadsTheWordsThatAskedAndASessionReadsItsChangeOpening() {
        val record = ScheduleChangeRecord.parse(json("""{"scheduleId":"a","revision":4,"changedBy":"USER","sessionId":"S9",
            "after":{"time":"10:00"},"askedText":"Run it at 10 instead"}"""))!!
        assertEquals("Run it at 10 instead", record.askedText)
        assertNull(ScheduleChangeRecord.parse(json("""{"scheduleId":"a","revision":4,"after":{}}"""))!!.askedText)
        val read = SessionScheduleCardsResponse.parse(json("""{"cards":[],"records":[],"change":$openingJson}"""))!!
        assertEquals("Codex stable check", read.change?.title)
        // Servers before it send no change; an unreadable one is none, never a failed read.
        assertNull(SessionScheduleCardsResponse.parse(json("""{"cards":[],"records":[]}"""))!!.change)
    }

    // The doors

    private val handle = SessionHandle(AccountKey("https://orbit.example/", "owner"))

    private class Server(var status: Int = 200, var body: String = "{}") : OrbitApi {
        val asked = mutableListOf<String>()
        val bodies = mutableListOf<String?>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val query = request.query.joinToString("&") { "${it.first}=${it.second}" }
            asked += "${request.method} ${request.path.joinToString("/")}" + if (query.isEmpty()) "" else "?$query"
            bodies += request.body?.decodeToString()
            return ApiResponse(status, body.encodeToByteArray())
        }
    }

    @Test fun allowSendsTheDevicesZoneAndReadsTheCard() = runTest {
        val server = Server(body = """{"outcome":"ALLOWED","card":{"id":"q1","kind":"CREATE","state":"ALLOWED"}}""")
        val outcome = ScheduleApi(server, handle).allow("q1", "Asia/Shanghai")
        assertEquals(listOf("POST schedule-requests/q1/allow"), server.asked)
        assertEquals("""{"timezone":"Asia/Shanghai"}""", server.bodies.single())
        assertEquals("ALLOWED", (outcome as ScheduleDecisionOutcome.Decided).card?.state)
        ScheduleApi(server, handle).allow("q2", null)
        ScheduleApi(server, handle).decline("q3")
        assertEquals(listOf("{}", "{}"), server.bodies.drop(1))
        assertEquals("POST schedule-requests/q3/decline", server.asked.last())
    }

    @Test fun aStaleCardIsAnAnswerNeverRetriedAndOtherRefusalsThrow() = runTest {
        val stale = Server(409, """{"code":"SCHEDULE_REQUEST_STALE","message":"The schedule changed since this card was asked."}""")
        assertEquals(ScheduleDecisionOutcome.Stale("The schedule changed since this card was asked."), ScheduleApi(stale, handle).allow("q1", null))
        assertEquals(1, stale.asked.size)
        val conflict = Server(409, """{"code":"SOMETHING_ELSE","message":"no"}""")
        val failure = runCatching { ScheduleApi(conflict, handle).decline("q1") }.exceptionOrNull() as ApiError
        assertEquals(409, failure.status)
        assertEquals("no", ScheduleApi.refusal(failure))
        assertEquals(ScheduleApi.UNREACHABLE, ScheduleApi.refusal(IllegalStateException()))
    }

    @Test fun aFailedPressSaysWhatWentWrong() {
        assertEquals("Couldn't reach Orbit. Try again.", ScheduleApi.refusal(NetworkException()))
        assertEquals("Orbit answered, but this version of the app couldn't read the reply. Update the app; the card shows what Orbit did.",
            ScheduleApi.refusal(ProtocolException()))
        assertEquals(ScheduleApi.UNREADABLE, ScheduleApi.refusal(SerializationException("bad")))
        assertEquals("Orbit couldn't do this (error 502). Try again.", ScheduleApi.refusal(ApiError.parse(502, "<html>".encodeToByteArray())))
        assertEquals("You're signed out. Sign in and try again.", ScheduleApi.refusal(ApiError.parse(401, "{}".encodeToByteArray())))
    }

    @Test fun anOlderServersListIsA404() = runTest {
        val failure = runCatching { ScheduleApi(Server(404, """{"message":"Cannot GET /api/schedules"}"""), handle).list() }.exceptionOrNull()
        assertEquals(404, (failure as ApiError).status)
    }

    @Test fun everyDoorPressesItsPath() = runTest {
        val server = Server(body = """{"schedules":[],"runs":[],"requests":[],"drafts":[],"sessionId":"S9","cards":[],"records":[]}""")
        val api = ScheduleApi(server, handle)
        assertEquals(emptyList<ScheduleView>(), api.list("ACTIVE,PAUSED", "w1").schedules)
        api.runs("a")
        api.pause("a"); api.resume("a"); api.runNow("a"); api.undo("a", 3); api.delete("a"); api.stopRun("r")
        api.requests()
        api.drafts()
        assertEquals("S9", api.createDraft("w1", "every day at 10"))
        api.sessionCards("S1")
        assertEquals(listOf("GET schedules?state=ACTIVE,PAUSED&workspaceId=w1", "GET schedules/a/runs?limit=20", "POST schedules/a/pause",
            "POST schedules/a/resume", "POST schedules/a/run", "POST schedules/a/undo", "DELETE schedules/a", "POST schedule-runs/r/stop",
            "GET schedule-requests?state=PENDING", "GET schedules/drafts", "POST schedules/drafts", "GET sessions/S1/schedule-cards"), server.asked)
        assertEquals(listOf(null, null, null, null, """{"revision":3}""", null, null, null, null, """{"workspaceId":"w1","text":"every day at 10"}""", null),
            server.bodies.drop(1))
    }

    @Test fun renamePostsTheTitleAlone() = runTest {
        val server = Server(body = """{"outcome":"APPLIED"}""")
        ScheduleApi(server, handle).rename("a", "US app 1070 data readiness")
        assertEquals(listOf("POST schedules/a/rename"), server.asked)
        assertEquals("""{"title":"US app 1070 data readiness"}""", server.bodies.single())
    }

    @Test fun theInspectorAndACardRead() = runTest {
        val server = Server(body = """{"schedule":{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"workspaceId":"w"},"id":"q","kind":"CREATE"}""")
        val api = ScheduleApi(server, handle)
        assertEquals("a", api.detail("a").schedule.id)
        assertEquals("q", api.request("q").id)
        assertEquals(listOf("GET schedules/a", "GET schedule-requests/q"), server.asked)
    }

    private val everyJson = """{"kind":"EVERY","minutes":30,"time":"09:00","until":"18:00","weekdays":["MON","TUE","WED","THU","FRI"]}"""

    /** The rule reader of the builds before EVERY: ONCE, DAILY and WHEN by name, any other kind weekly. */
    private fun oldFallbackRule(o: kotlinx.serialization.json.JsonObject): ScheduleRule? {
        val kind = o.scheduleText("kind") ?: return null
        return when (kind) {
            "ONCE" -> ScheduleRule.Once(o.scheduleText("at") ?: return null)
            "DAILY" -> ScheduleRule.Daily(o.scheduleText("time") ?: return null)
            else -> ScheduleRule.Weekly(o.scheduleText("time") ?: return null, o.scheduleStrings("weekdays") ?: emptyList())
        }
    }

    @Test fun everyRuleReadsAndTheOldWeeklyFallbackKeepsIt() {
        val rule = ScheduleRule.parse(json(everyJson))
        assertEquals(ScheduleRule.Every(30, "09:00", listOf("MON", "TUE", "WED", "THU", "FRI"), "18:00"), rule)
        assertEquals(rule, ScheduleRule.parse(rule!!.toJson()))
        // The same JSON through the old fallback is a weekly rule, not null: a shipped build keeps the schedule.
        assertEquals(ScheduleRule.Weekly("09:00", listOf("MON", "TUE", "WED", "THU", "FRI")),
            oldFallbackRule(json(everyJson) as kotlinx.serialization.json.JsonObject))
        // A list holding an EVERY schedule still reads whole.
        val list = """{"schedules":[{"id":"s1","title":"Poll","workspaceId":"w","timezone":"UTC","rule":$everyJson,"maxRuns":3,"runsLeft":2}]}"""
        val view = ScheduleListResponse.parse(json(list))!!.schedules.single()
        assertEquals(rule, view.rule)
        assertEquals(3, view.maxRuns)
        assertEquals(2, view.runsLeft)
        // EVERY without a readable interval is read as weekly, not dropped.
        assertEquals(ScheduleRule.Weekly("09:00", emptyList()), ScheduleRule.parse(json("""{"kind":"EVERY","time":"09:00"}""")))
    }

    @Test fun theChangeDoorsReadAndOpen() = runTest {
        val server = Server(body = """{"sessionId":"S9","opening":$openingJson,"created":true}""")
        val api = ScheduleApi(server, handle)
        assertEquals("S9", api.change("a").sessionId)
        assertEquals("Codex stable check", api.change("a").opening.title)
        assertEquals(ScheduleChangeAnswer("S9", true), api.openChange("a", "Run it at 10 instead"))
        assertEquals(listOf("GET schedules/a/change", "GET schedules/a/change", "POST schedules/a/change"), server.asked)
        assertEquals("""{"text":"Run it at 10 instead"}""", server.bodies.last())
        // A POST that names no session is unreadable, not a wrong id.
        val refusal = runCatching { ScheduleApi(Server(body = """{"created":true}"""), handle).openChange("a", "x") }.exceptionOrNull()
        assertTrue(refusal is ProtocolException)
    }
}

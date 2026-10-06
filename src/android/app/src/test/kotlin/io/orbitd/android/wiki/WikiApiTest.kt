package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Fixed user-door request shape and stale authority checks; no deployed-account claim. */
@OptIn(ExperimentalCoroutinesApi::class)
class WikiApiTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private val entry = obj("""{"id":"entry","spaceId":"space","kind":"convention","status":"active","trust":"unreviewed","currentRevision":7,"title":"Original","summary":"Summary","fields":{"rule":"keep"},"topics":["sessions"],"aliases":["alias"],"anchors":[{"type":"path","path":"a.kt","check":{"state":"verified"},"serverOnly":"never"}]}""")

    private class Rig(test: TestScope) {
        val calls = mutableListOf<HttpRequest>()
        var answer: (ApiRequest) -> ApiResponse = { ApiResponse(200, "{}".encodeToByteArray()) }
        val auth = AuthSession(HttpTransport { request ->
            calls += request
            if (request.api.path.first() == "auth") ApiResponse(200, """{"accessToken":"owner-access","refreshToken":"owner-refresh","user":{"id":"owner","email":"owner@example.test","name":"Owner"}}""".encodeToByteArray())
            else answer(request.api)
        }, object : CredentialStore {
            var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
            override suspend fun clearAll() = Unit
        }, "a12-test", dispatcher = StandardTestDispatcher(test.testScheduler))
        suspend fun start(): WikiApi {
            val handle = auth.login(ServerAddress.parse("https://wiki.example.test"), "owner@example.test", "test-password")
            calls.clear()
            return WikiApi(auth, handle)
        }
    }

    @Test fun apiUsesExactUserPathsQueriesAndInheritedOwnerAuth() = runTest {
        val rig = Rig(this); val api = rig.start()
        rig.answer = { request -> ApiResponse(200, (if (request.path == listOf("wiki", "search")) "{\"hits\":[]}" else "{}").encodeToByteArray()) }
        api.entry("entry")
        assertEquals(listOf("wiki", "entries", "entry"), rig.calls.last().api.path)
        assertEquals(listOf("include" to "sources,history,exposure"), rig.calls.last().api.query)
        api.search("space", "  original  ")
        assertEquals(listOf("q" to "original", "space" to "space"), rig.calls.last().api.query)
        api.updateSpace("space", obj("""{"maintenance":{"lookbackDays":null},"reviewMode":"manual"}"""))
        assertEquals(HttpMethod.PATCH, rig.calls.last().api.method)
        assertEquals(listOf("wiki", "spaces", "space"), rig.calls.last().api.path)
        val body = Json.parseToJsonElement(rig.calls.last().api.body!!.decodeToString()).jsonObject
        assertEquals(JsonNull, body["settings"]!!.jsonObject["maintenance"]!!.jsonObject["lookbackDays"])
        assertTrue(rig.calls.all { it.accessToken == "owner-access" && it.server.value == "https://wiki.example.test/" })
        assertFalse(body.containsKey("sessionId"))
    }

    @Test fun optional404IsAbsenceButForbiddenAndStaleRemainErrors() = runTest {
        val rig = Rig(this); val api = rig.start()
        rig.answer = { ApiResponse(404, "{}".encodeToByteArray()) }
        assertNull(api.optional("wiki", "entries", "missing"))
        for (status in listOf(403, 409, 503)) {
            rig.answer = { ApiResponse(status, "{\"message\":\"controlled refusal\"}".encodeToByteArray()) }
            try { api.optional("wiki", "entries", "entry"); fail("$status must not become missing") }
            catch (error: ApiError) { assertEquals(status, error.status) }
        }
    }

    @Test fun oldAccountHandleCannotReadOrWriteAfterLoginSwitch() = runTest {
        val rig = Rig(this); val old = rig.start()
        rig.auth.login(ServerAddress.parse("https://wiki.example.test"), "owner@example.test", "test-password")
        rig.calls.clear()
        try { old.entry("entry"); fail("old read escaped") } catch (_: SessionChanged) { }
        try { old.updateSpace("space", obj("{}")); fail("old write escaped") } catch (_: SessionChanged) { }
        assertTrue(rig.calls.isEmpty())
    }

    @Test fun ownerReplacementRetainsContentButDropsServerAnchorKeys() {
        val request = ownerRequest(entry, "supersede", " Replacement ", " Revised ", "", "press-1")
        assertEquals("wiki-supersede:press-1", request["idempotencyKey"]!!.jsonPrimitive.content)
        val op = request["ops"]!!.jsonArray.single().jsonObject
        assertEquals(7, op["baseRevision"]!!.jsonPrimitive.int)
        val draft = op["entry"]!!.jsonObject
        assertEquals("Replacement", draft["title"]!!.jsonPrimitive.content)
        assertEquals(entry["fields"], draft["fields"])
        assertEquals(entry["aliases"], draft["aliases"])
        assertEquals(obj("""{"type":"path","path":"a.kt"}"""), draft["anchors"]!!.jsonArray.single())
        assertEquals(request, ownerRequest(entry, "supersede", " Replacement ", " Revised ", "", "press-1"))
        assertThrows(IllegalArgumentException::class.java) { ownerRequest(entry, "retire", "", "", " ", "press") }
    }

    @Test fun sessionSourcesPreserveRecordIdAndNeverOpenWithdrawnRecords() {
        for (kind in listOf("turn", "event", "tool_call")) {
            val route = wikiSourceRoute(obj("""{"kind":"$kind","sessionId":"original-session","recordId":"original-record","seq":901}"""), true)!!
            assertEquals(Destination.SESSION, route.destination)
            assertEquals("original-session", route.id)
            assertEquals("original-record", route.recordId)
        }
        val legacy = obj("""{"kind":"turn","ref":"original-session","locator":{"turnId":"original-record"}}""")
        assertEquals("original-record", wikiSourceRoute(legacy)!!.recordId)
        for (status in listOf("trashed", "deleted")) assertNull(wikiSourceRoute(JsonObject(legacy + ("state" to JsonPrimitive(status)))))
        assertNull(wikiSourceRoute(obj("""{"kind":"event","recordId":"record"}""")))
        assertEquals(Destination.TASK, wikiSourceRoute(obj("""{"kind":"task_comment","taskId":"task"}"""), true)!!.destination)
    }

    @Test fun repositorySourcePinsCommitAndEscapesIndividualPathSegments() {
        val note = obj("""{"kind":"code","path":"src/space name/a#b.kt","sha":"0123456789abcdef","lineStart":12,"lineEnd":19}""")
        assertEquals("https://github.com/owner/repo/blob/0123456789abcdef/src/space%20name/a%23b.kt#L12-L19", wikiRepositoryLink(note, "github.com/owner/repo.git"))
        assertNull(wikiRepositoryLink(note, "gitlab.com/owner/repo"))
        assertNull(wikiRepositoryLink(JsonObject(note - "sha"), "github.com/owner/repo"))
    }

    @Test fun planInputsKeepExtensionFieldsAndConvertResolvedProjectObjectsToIds() {
        val section = obj("""{"id":"server-id","position":4,"key":"s1","title":"Section","kind":"flow","extra":{"future":"kept"},"sources":{"sessions":{"projects":[{"id":"p1","title":"Resolved"},"p2"],"keywords":["wake"]}}}""")
        val input = planSectionInput(section)
        assertFalse(input.containsKey("id")); assertFalse(input.containsKey("position"))
        assertEquals(section["extra"], input["extra"])
        assertEquals(Json.parseToJsonElement("[\"p1\",\"p2\"]"), input["sources"]!!.jsonObject["sessions"]!!.jsonObject["projects"])
        val doc = obj("""{"id":"server-doc","slug":"sessions","extra":{"future":"kept"}}""")
        val sent = planDocInput(JsonObject(doc + ("sections" to JsonArray(listOf(section)))))
        assertFalse(sent.containsKey("id")); assertEquals(doc["extra"], sent["extra"])
        assertEquals(input, sent["sections"]!!.jsonArray.single())
    }

    @Test fun entryAndPlanCardsOnlyExposeFixedIOSActionsAndCorrectSpace() {
        assertEquals(listOf(CardVerb.WIKI_CONFIRM, CardVerb.WIKI_REJECT_ENTRY), wikiEntryCards(entry).single().actions)
        assertEquals(listOf(CardVerb.WIKI_REJECT_ENTRY), wikiEntryCards(JsonObject(entry + ("trust" to JsonPrimitive("auto")))).single().actions)
        assertTrue(wikiEntryCards(JsonObject(entry + ("status" to JsonPrimitive("retired")))).single().actions.isEmpty())
        val plan = obj("""{"spaceId":"space","draft":{"id":"draft","version":2,"status":"draft"},"proposals":[]}""")
        val request = CardRequests.build(wikiPlanCards(plan).single(), CardVerb.PLAN_CONFIRM, CardInput())
        assertEquals(listOf("wiki", "spaces", "space", "plan", "versions", "2", "confirm"), request.path)
    }

    @Test fun cardMutationRereadsAndRefusesAChangedRevisionBeforeAnyPost() = runTest {
        val rig = Rig(this); val api = rig.start()
        val shown = wikiEntryCards(entry).single()
        rig.answer = { ApiResponse(200, JsonObject(entry + ("currentRevision" to JsonPrimitive(8))).toString().encodeToByteArray()) }
        try { api.cardAction(shown, CardVerb.WIKI_CONFIRM, CardInput()); fail("stale confirmation escaped") }
        catch (error: IllegalStateException) { assertTrue(error.message!!.contains("changed")) }
        assertEquals(listOf(HttpMethod.GET), rig.calls.map { it.api.method })
        rig.calls.clear()
        rig.answer = { request -> ApiResponse(200, (if (request.method == HttpMethod.GET) entry.toString() else "{}").encodeToByteArray()) }
        api.cardAction(shown, CardVerb.WIKI_CONFIRM, CardInput())
        assertEquals(listOf(HttpMethod.GET, HttpMethod.POST), rig.calls.map { it.api.method })
        assertEquals(listOf("wiki", "entries", "entry", "confirm"), rig.calls.last().api.path)
    }

    @Test fun explicitMissingSpaceCannotFallThroughToAnotherSpace() = runTest {
        val rig = Rig(this); val api = rig.start()
        rig.answer = { ApiResponse(200, """[{"id":"other","slug":"other"}]""".encodeToByteArray()) }
        try { api.page(OrbitRoute(Destination.WIKI, "missing"), null); fail("missing space became another home") }
        catch (error: ApiError) { assertEquals(404, error.status) }
        assertEquals(1, rig.calls.size)
    }

    @Test fun linkedEntryUsesItsOwnSpaceInsteadOfPreviouslySelectedSpace() = runTest {
        val rig = Rig(this); val api = rig.start()
        rig.answer = { request -> ApiResponse(200, (if (request.path.last() == "spaces")
            """[{"id":"other","slug":"other"},{"id":"space","slug":"entry-space"}]""" else entry.toString()).encodeToByteArray()) }
        val page = api.page(OrbitRoute(Destination.WIKI_ENTRY, "entry"), "other")
        assertEquals("space", page.space?.text("id"))
        assertEquals("entry", page.content.text("id"))
    }

    @Test fun ownerOutcomeMustActuallyApplyEvenWhenServerSendsNoReasonText() = runTest {
        val rig = Rig(this); val api = rig.start()
        for (status in listOf("conflict", "refused", "pending", "future")) {
            rig.answer = { ApiResponse(200, """{"ops":[{"status":"$status","reasons":[]}]}""".encodeToByteArray()) }
            try { api.ownerWrite(entry, "amend", "Updated", "Changed", key = "press"); fail("$status became success") }
            catch (error: IllegalStateException) { assertTrue(error.message!!.contains("not applied")) }
        }
        rig.answer = { ApiResponse(200, """{"ops":[{"status":"applied","revision":8}]}""".encodeToByteArray()) }
        api.ownerWrite(entry, "amend", "Updated", "Changed", key = "press")
    }

    @Test fun connectionLossDuringCardReadPreventsMutation() = runTest {
        val rig = Rig(this); rig.start()
        var connected = true
        val handle = (rig.auth.state.value as AuthState.SignedIn).handle
        val api = WikiApi(rig.auth, handle) { connected }
        rig.answer = { connected = false; ApiResponse(200, entry.toString().encodeToByteArray()) }
        try { api.cardAction(wikiEntryCards(entry).single(), CardVerb.WIKI_CONFIRM, CardInput()); fail("disconnected write escaped") }
        catch (error: IllegalStateException) { assertTrue(error.message!!.contains("Reconnect")) }
        assertEquals(listOf(HttpMethod.GET), rig.calls.map { it.api.method })
    }
}

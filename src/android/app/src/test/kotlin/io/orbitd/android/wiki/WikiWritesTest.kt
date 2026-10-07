package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The owner's writes run on the store's own scope to their answer: whoever asked can go — a page left, a sheet
 * closed — and A03's AuthSession, which cancels a request whose caller is cancelled, is never asked to. Then what a
 * decide's answer says about the op it answered, and that a read answering after a newer one is not adopted. */
class WikiWritesTest {
    private val space = WikiFixtures.spaceID
    private val entry = WikiFixtures.pitfallID
    private val run = "34UDCsMaintenanceRun01"
    private val proposal = "34UDPlanProposal000001"

    /** An in-memory server whose requests can be held at a gate; each held one is recorded as answered or cancelled. */
    private class Server {
        val calls = CopyOnWriteArrayList<String>()
        val ended = ConcurrentHashMap<String, String>()
        private val gates = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
        private val decided = ConcurrentHashMap.newKeySet<String>()
        @Volatile var decision = "accepted"
        fun hold(method: String, path: String) = CompletableDeferred<Unit>().also { gates["$method $path"] = it }
        fun inFlight(method: String, path: String) = calls.count { it == "$method $path" }
        private val versions get() = WikiPlanFixture.plan.fobj("versions")
        private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
        private fun spelled(path: List<String>) = path.joinToString("/") { part ->
            listOf(WikiFixtures.spaceID, WikiFixtures.pitfallID).firstOrNull { ObjectId.same(it, part) } ?: part
        }
        private fun review(): String = JsonArray(Wire.json.parseToJsonElement(WikiFixtures.review).jsonArray.map { changeset ->
            val ops = changeset.jsonObject.getValue("ops").jsonArray.filter { it.jsonObject.getValue("id").jsonPrimitive.content !in decided }
            JsonObject(changeset.jsonObject + ("ops" to JsonArray(ops)))
        }).toString()
        private fun respond(api: ApiRequest): ApiResponse {
            val path = spelled(api.path)
            val space = WikiFixtures.spaceID
            return when (path) {
                "wiki/spaces" -> ok(WikiFixtures.spaces)
                "wiki/spaces/$space" -> ok(WikiFixtures.space)
                "wiki/spaces/$space/entries" -> ok(WikiFixtures.entries)
                "wiki/spaces/$space/timeline" -> ok(WikiFixtures.timeline)
                "wiki/spaces/$space/changesets" -> ok("""{"changesetId":"34UDCsOwnerEdit000009","ops":[{"seq":0,"status":"applied","entryId":"${WikiFixtures.pitfallID}","revision":3}]}""")
                "wiki/entries/${WikiFixtures.pitfallID}" -> ok(WikiFixtures.entryDetail)
                "wiki/entries/${WikiFixtures.pitfallID}/confirm", "wiki/entries/${WikiFixtures.pitfallID}/reject" -> ok("{}")
                "wiki/review" -> ok(review())
                "wiki/spaces/$space/plan" -> ok(buildJsonObject { put("spaceId", space); put("confirmed", versions.fobj("v1")); put("draft", JsonNull)
                    put("proposals", JsonArray(emptyList())); put("job", JsonNull) }.toString())
                "wiki/spaces/$space/plan/redraft" -> ok("""{"created":true}""")
                "wiki/spaces/$space/plan/versions/2/confirm", "wiki/spaces/$space/plan/edits" -> ok(versions.fobj("v2").toString())
                else -> when {
                    path.endsWith("/revert") -> ok("""{"reverted":1}""")
                    path.startsWith("wiki/plan-proposals/") -> ok(buildJsonObject {
                        put("draft", if (Wire.json.parseToJsonElement(api.body!!.decodeToString()).jsonObject["action"]?.jsonPrimitive?.content == "accept")
                            versions.fobj("v2") else JsonNull) }.toString())
                    path.startsWith("wiki/changesets/") && path.endsWith("/decide") -> {
                        val opId = Wire.json.parseToJsonElement(api.body!!.decodeToString()).jsonObject.getValue("decisions").jsonArray[0]
                            .jsonObject.getValue("opId").jsonPrimitive.content
                        decided += opId
                        val row = Wire.json.parseToJsonElement(WikiFixtures.review).jsonArray.map { it.jsonObject }.first { it.getValue("id").jsonPrimitive.content == api.path[2] }
                        val ops = row.getValue("ops").jsonArray.map { op -> if (op.jsonObject.getValue("id").jsonPrimitive.content != opId) op
                            else JsonObject(op.jsonObject + ("decision" to JsonPrimitive(decision))) }
                        ok(JsonObject(row + ("ops" to JsonArray(ops))).toString())
                    }
                    path.startsWith("wiki/changesets/") -> ok("""{"id":"${api.path[2]}","origin":"maintenance","createdAt":"2026-10-05T00:00:00Z","ops":[],"entries":[],
                        "counts":{"applied":1,"auto":1,"unreviewed":0,"rejectedByCheck":0,"toReview":0},"revertible":true,"revert":{"adds":1,"amends":0}}""")
                    else -> ApiResponse(404, """{"message":"not found"}""".encodeToByteArray())
                }
            }
        }
        val auth = AuthSession(HttpTransport { request ->
            if (request.api.path == listOf("auth", "login")) return@HttpTransport ok(
                """{"accessToken":"a","refreshToken":"r","user":{"id":"u1","email":"owner@example.test","name":"Owner"}}""")
            val key = "${request.api.method.name} ${spelled(request.api.path)}"
            calls += key
            val answer = respond(request.api)
            gates.remove(key)?.let { gate ->
                try { gate.await() } catch (cancel: CancellationException) { ended[key] = "cancelled"; throw cancel }
                ended[key] = "answered"
            }
            answer
        }, object : CredentialStore {
            private var saved: StoredSession? = null
            override suspend fun load() = saved
            override suspend fun save(session: StoredSession) { saved = session }
            override suspend fun clear() { saved = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test", dispatcher = Dispatchers.Unconfined)
        val handle: SessionHandle = runBlocking { auth.login(ServerAddress.parse("https://wiki.test"), "owner@example.test", "pw") }
        fun store() = WikiStore(auth, handle, CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
    }

    private val detail get() = WikiEntryDetail.decode(Wire.json.parseToJsonElement(WikiFixtures.entryDetail))
    private val spaceRow get() = Wire.json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(WikiSpace.serializer()), WikiFixtures.spaces).first()

    /** [write] is asked for by a caller that is then cancelled while its request waits; the request answers anyway. */
    private fun outlivesItsCaller(method: String, path: String, write: suspend (WikiStore) -> Unit) {
        val server = Server()
        val store = server.store()
        runBlocking { store.loadSpaces(); store.loadPlan() }
        val gate = server.hold(method, path)
        val caller = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        caller.launch { write(store) }
        assertEquals("$method $path is in flight", 1, server.inFlight(method, path))
        caller.cancel()
        gate.complete(Unit)
        assertEquals("$method $path went on to its answer after its caller went", "answered", server.ended["$method $path"])
    }

    @Test fun anEditOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/changesets") { it.edit(detail.entry, "A title", "A summary") }
    @Test fun aSupersedeOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/changesets") { it.supersede(detail.entry, "A title", "A summary") }
    @Test fun aRetireOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/changesets") { it.retire(detail.entry, "No longer true") }
    @Test fun aConfirmOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/entries/$entry/confirm") { it.confirm(detail.entry) }
    @Test fun aRejectOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/entries/$entry/reject") { it.reject(entry, WikiCopy.rejectReasons.first()) }
    @Test fun aSettingsWriteOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("PATCH", "wiki/spaces/$space") { it.updateSpace(spaceRow, buildJsonObject { put("reviewMode", "tiered") }) }
    @Test fun aRevertOutlivesThePageThatAskedForIt() = outlivesItsCaller("POST", "wiki/changesets/$run/revert") { store ->
        store.loadRun(run); store.revert(store.state.value.run(run)!!)
    }
    @Test fun aRedraftOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/plan/redraft") { it.redraftPlan("Fewer documents") }
    @Test fun aPlanConfirmOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/plan/versions/2/confirm") { it.confirmPlan(2) }
    @Test fun aPlanEditOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/spaces/$space/plan/edits") { it.editPlan(buildJsonObject { put("baseVersion", 1) }) }
    @Test fun aPlanProposalsRejectOutlivesThePageThatAskedForIt() =
        outlivesItsCaller("POST", "wiki/plan-proposals/$proposal/decide") { it.rejectPlanProposal(proposal) }

    /** Accept is two writes — the proposal's decide, then the confirm of the draft it made: the second goes out and
     * answers even when the page that pressed Accept is gone by then. */
    @Test fun aPlanAcceptConfirmsItsDraftEvenWhenThePageGoesBetweenTheTwoWrites() =
        outlivesItsCaller("POST", "wiki/spaces/$space/plan/versions/2/confirm") { it.acceptPlanProposal(proposal, confirm = true) }

    // MARK: what a decide's answer says

    private fun amendCard(store: WikiStore) = store.state.value.reviewCards.first { it.op.id == "34UDOpAmendDeploy0003" }
    private fun addCard(store: WikiStore) = store.state.value.reviewCards.first { it.op.id == "34UDOpAddPitfall00001" }

    @Test fun anAcceptTheServerRecordedAsAConflictIsARefusalThatAppliedNothing() = runBlocking {
        val server = Server().apply { decision = "conflict" }
        val store = server.store()
        store.loadReview()
        val answer = store.decide(amendCard(store), "accept")
        assertEquals("Nothing was applied: the entry changed after this was proposed.", answer)
    }

    @Test fun anAnswerTheServerRecordedAsWithdrawnIsARefusalThatAppliedNothing() = runBlocking {
        val server = Server().apply { decision = "withdrawn" }
        val store = server.store()
        store.loadReview()
        val answer = store.decide(addCard(store), "accept")
        assertEquals("Nothing was applied: the proposal was withdrawn.", answer)
    }

    @Test fun anAcceptTheServerRecordedAsAcceptedIsNoRefusal() = runBlocking {
        val store = Server().store()
        store.loadReview()
        assertNull(store.decide(amendCard(store), "accept"))
    }

    // MARK: reads — the newest one asked for is the one adopted

    @Test fun aReviewReadThatAnswersAfterANewerOneIsNotAdopted() = runBlocking {
        val server = Server()
        val store = server.store()
        store.loadReview()
        val card = amendCard(store)
        // A re-read goes out while the op still waits, and is slow to answer.
        val late = server.hold("GET", "wiki/review")
        val reader = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined).launch { store.loadReview() }
        // The owner accepts; the store's own re-read after the write answers first.
        assertNull(store.decide(card, "accept"))
        late.complete(Unit)
        reader.join()
        assertTrue("the answered op stays answered", store.state.value.reviewCards.none { it.op.id == card.op.id })
        assertTrue("and the queue is the newer read's", store.state.value.review.flatMap { it.ops.orEmpty() }.none { it.id == card.op.id })
    }

    @Test fun nudgesNeverStartAReReadWhileOneIsInFlight() {
        val server = Server()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val store = WikiStore(server.auth, server.handle, scope)
        runBlocking { store.loadHome() }
        val first = server.hold("GET", "wiki/spaces")
        val before = server.inFlight("GET", "wiki/spaces")
        store.nudge()
        Thread.sleep(1_500)
        assertEquals("the first re-read is out", before + 1, server.inFlight("GET", "wiki/spaces"))
        store.nudge()
        Thread.sleep(1_500)
        assertEquals("a second nudge waits for the re-read in flight", before + 1, server.inFlight("GET", "wiki/spaces"))
        first.complete(Unit)
        Thread.sleep(1_500)
        assertTrue("and then reads once more", server.inFlight("GET", "wiki/spaces") >= before + 2)
        scope.cancel()
    }
}

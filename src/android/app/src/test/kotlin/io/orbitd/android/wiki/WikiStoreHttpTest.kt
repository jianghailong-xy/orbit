package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** WikiStore + WikiClient over real loopback HTTP (A03's AuthSession and OkHttp transport) against a scripted
 * authority. It proves which requests the Android client sends and how it treats the answers; it is not a
 * deployed backend, and proves nothing about the server's own review policy or database. */
class WikiStoreHttpTest {
    private val space = "01a0cca7-8609-70ed-a0e2-d4b55b832b70"
    private val entryId = "01a0cca7-8609-70ed-a0e2-d4b55b832b72"
    private val changeset = "01a0cca7-8609-70ed-a0e2-d4b55b832b90"
    private val run = "01a0cca7-8609-70ed-a0e2-d4b55b832b91"
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val task = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"

    private inner class Authority : AutoCloseable {
        val server = MockWebServer()
        val calls = CopyOnWriteArrayList<Pair<String, String>>()
        val pending = ConcurrentHashMap.newKeySet<String>().apply { addAll(listOf("op-add", "op-amend", "op-retire", "op-challenge")) }
        @Volatile var decideStatus = 200
        /** What a decide's answer records for the op decided, as the server's changeset answer does; null answers the count. */
        @Volatile var recorded: String? = null
        @Volatile var entryStatus = 200
        @Volatile var writeAnswer = """{"changesetId":"$changeset","ops":[{"seq":0,"status":"applied","entryId":"$entryId","revision":4}]}"""
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val url = request.requestUrl!!
                    val path = url.encodedPath.removePrefix("/api/")
                    val query = url.encodedQuery?.let { "?$it" } ?: ""
                    val sent = request.body.readUtf8()
                    calls += "${request.method} $path$query" to sent
                    return when {
                        path == "auth/login" -> ok("""{"accessToken":"wiki-access","refreshToken":"wiki-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                        path == "wiki/spaces" -> ok("""[{"id":"$space","slug":"orbit","repoUrlNorm":"github.com/orbitd/orbit","pendingOps":4,"rootCommitSha":"0123456789abcdef"}]""")
                        path == "wiki/spaces/$space" && request.method == "GET" -> ok("""{"id":"$space","slug":"orbit","pendingOps":4,"usage":{"days":7,"sessionsPushed":3,"searches":5,"entries":[{"entryId":"$entryId","title":"Use the A06 reader","total":4}]}}""")
                        path == "wiki/spaces/$space/entries" -> ok("[${entryJson()}]")
                        path == "wiki/spaces/$space/timeline" -> ok("""{"items":[{"opId":"t1","op":"add","decision":"auto_applied","origin":"maintenance","at":"2026-10-05T00:00:00Z","entryId":"$entryId","title":"Use the A06 reader","kind":"decision","status":"active","trust":"auto","appliedByMode":"automatic","changesetId":"$run","changesetAppliedByMode":"automatic"}]}""")
                        path == "wiki/spaces/$space/health" -> ok("""{"spaceId":"$space","entries":12,"maintenance":{"look":"ok","enabled":true,"consecutiveFailures":0,"backlog":0,"lagSeconds":0,"dailyLimitReached":false}}""")
                        path == "wiki/changesets/$run" -> ok("""{"id":"$run","origin":"maintenance","sessionId":"$session","createdAt":"2026-10-05T00:00:00Z","ops":[],"entries":[],"counts":{"applied":2,"auto":1,"unreviewed":1,"rejectedByCheck":0,"toReview":0},"revertible":true,"revert":{"adds":1,"amends":1}}""")
                        path == "wiki/changesets/$run/revert" -> ok("""{"reverted":2}""")
                        path == "wiki/review" -> ok("[${reviewJson()}]")
                        path == "wiki/changesets/$changeset/decide" -> if (decideStatus != 200)
                            MockResponse().setResponseCode(decideStatus).setBody("""{"code":"WIKI_STALE","message":"This proposal changed since you opened it."}""")
                            else {
                                val opId = Json.parseToJsonElement(sent).jsonObject["decisions"]!!.jsonArray[0].jsonObject["opId"]!!.jsonPrimitive.content
                                val answer = recorded?.let { decision ->
                                    val row = Json.parseToJsonElement(reviewJson()).jsonObject
                                    JsonObject(row + ("ops" to JsonArray(row["ops"]!!.jsonArray.map { op ->
                                        if (op.jsonObject["id"]!!.jsonPrimitive.content != opId) op
                                        else JsonObject(op.jsonObject + ("decision" to JsonPrimitive(decision))) }))).toString()
                                } ?: """{"decided":1}"""
                                pending.remove(opId); ok(answer)
                            }
                        path == "wiki/entries/$entryId" -> if (entryStatus == 200) ok(detailJson()) else MockResponse().setResponseCode(entryStatus).setBody("{}")
                        path == "wiki/entries/$entryId/confirm" || path == "wiki/entries/$entryId/reject" -> ok("{}")
                        path == "wiki/spaces/$space/changesets" -> ok(writeAnswer)
                        path == "wiki/search" -> ok("""{"q":"reader","hits":[{"id":"$entryId","kind":"decision","title":"Use the A06 reader","summary":"One reader"}]}""")
                        path == "link-previews" -> ok("""{"previews":[{"kind":"task","id":"x","state":"ok","task":{"title":"Port the reader"}},{"kind":"session","id":"y","state":"unavailable"}]}""")
                        else -> MockResponse().setResponseCode(404).setBody("{}")
                    }
                }
            }
            server.start()
        }
        fun ok(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
        fun entryJson() = """{"id":"$entryId","spaceId":"$space","kind":"decision","status":"active","trust":"unreviewed","currentRevision":3,
            "title":"Use the A06 reader","summary":"One reader for every transcript","fields":{"decision":"Reuse it"},
            "topics":["reader"],"aliases":["reader reuse"],"validFrom":"2026-10-01T00:00:00Z","recordedAt":"2026-10-01T00:00:00Z",
            "anchors":[{"type":"path","path":"src/android/README.md","check":{"state":"verified","ref":"abc"}}]}"""
        fun detailJson() = entryJson().trimEnd('}') + """,
            "sources":[{"id":"s1","kind":"task","ref":"$task","quote":"q","quoteVerified":true},{"id":"s2","kind":"turn","ref":"$session","locator":{"turnId":"r1"}}],
            "history":[{"id":"h1","revision":3,"authorKind":"maintenance","createdAt":"2026-10-01T00:00:00Z"}],"exposure":[]}"""
        fun op(id: String, seq: Int, op: String, payload: String, entry: String? = entryId) =
            """{"id":"$id","seq":$seq,"op":"$op","entryId":${entry?.let { "\"$it\"" } ?: "null"},"baseRevision":3,"payload":$payload,"decision":"pending"}"""
        fun reviewJson(): String {
            val ops = listOf(
                op("op-add", 0, "add", """{"entry":{"kind":"pitfall","title":"New pitfall","summary":"Watch out"}}""", null),
                op("op-amend", 1, "amend", """{"changes":{"title":"Use the A06 reader everywhere","fields":{"decision":"Reuse"},"topics":["reader"],"anchors":[{"type":"path","path":"a.kt","check":{"state":"verified"}}]}}"""),
                op("op-retire", 2, "retire", """{"reason":"No longer true"}"""),
                op("op-challenge", 3, "challenge", """{"reason":"Anchor moved"}"""),
            ).filter { Json.parseToJsonElement(it).jsonObject["id"]!!.jsonPrimitive.content in pending }
            return """{"id":"$changeset","spaceId":"$space","origin":"session","sessionId":"$session","rationale":"From the review session","createdAt":"2026-10-04T00:00:00Z","ops":[${ops.joinToString(",")}]}"""
        }
        override fun close() = server.shutdown()
    }

    private val authority = Authority()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
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
    }, "test", allowLoopbackHttp = true)

    private fun store(): WikiStore = runBlocking {
        auth.login(ServerAddress.parse(authority.server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "password")
        WikiStore(auth, (auth.state.value as AuthState.SignedIn).handle, scope)
    }
    private fun requests(prefix: String) = authority.calls.filter { it.first.startsWith(prefix) }
    private fun body(prefix: String) = Json.parseToJsonElement(requests(prefix).last().second).jsonObject
    private fun eventually(condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 60_000
        while (!condition()) { check(System.currentTimeMillis() < until) { "condition never held" }; Thread.sleep(20) }
    }

    @After fun close() { scope.cancel(); authority.close() }

    @Test fun homeReadsTheSpaceThenItsFourReadsAndEveryRunItFolds() = runBlocking {
        val store = store()
        store.loadHome()
        val reads = authority.calls.map { it.first }
        listOf("GET wiki/spaces", "GET wiki/spaces/$space?include=usage", "GET wiki/spaces/$space/entries?limit=200",
            "GET wiki/spaces/$space/timeline", "GET wiki/spaces/$space/health", "GET wiki/changesets/$run").forEach {
            assertTrue("missing $it in $reads", it in reads)
        }
        val home = store.state.value.home!!
        assertEquals(4, home.proposals)
        assertEquals(12, home.health!!.entries)
        assertEquals(listOf(run), home.recentRunIds)
        assertEquals(2, WikiModeLogic.runSummary(home.run(run)!!).applied)
        assertEquals(LoadPresentation.CONTENT, presentation(store.state.value.homeState, false))
    }

    @Test fun searchAsksTheSpaceOnScreenForTopics() = runBlocking {
        val store = store()
        store.loadHome()
        val hits = store.search("  reader ")
        assertEquals(listOf(entryId), hits.map { it.id })
        assertEquals("GET wiki/search?q=reader&include=topics&space=$space", requests("GET wiki/search").single().first)
        assertTrue(store.search("   ").isEmpty())
        assertEquals(1, requests("GET wiki/search").size)
    }

    @Test fun eachReviewAnswerIsOneDecisionAndTheCardLeavesOnlyWhenTheServerTookIt() = runBlocking {
        val store = store()
        store.loadReview()
        val cards = store.state.value.reviewCards
        assertEquals(listOf("op-add", "op-amend", "op-retire", "op-challenge"), cards.map { it.op.id })

        assertNull(store.decide(cards[0], "accept"))
        assertEquals(buildJsonObject { putJsonArray("decisions") { add(buildJsonObject { put("opId", "op-add"); put("action", "accept") }) } },
            body("POST wiki/changesets/$changeset/decide"))
        assertFalse(store.state.value.reviewCards.any { it.op.id == "op-add" })

        assertNull(store.decide(cards[2], "reject", "not_true"))
        assertEquals("not_true", body("POST wiki/changesets/$changeset/decide")["decisions"]!!.jsonArray[0].jsonObject["reason"]!!.jsonPrimitive.content)

        // The owner's version: an edit carries exactly the keys the form built.
        val edited = buildJsonObject { put("title", "Owner title"); put("summary", "Owner line") }
        assertNull(store.decide(cards[1], "edit", edited = edited))
        val decision = body("POST wiki/changesets/$changeset/decide")["decisions"]!!.jsonArray[0].jsonObject
        assertEquals("edit", decision["action"]!!.jsonPrimitive.content)
        assertEquals(edited, decision["edited"])
        // The re-reads catch the queue up behind the answers: what the server no longer lists stays gone.
        eventually { store.state.value.review.flatMap { it.ops.orEmpty() }.none { it.id in setOf("op-add", "op-retire", "op-amend") } }
        assertEquals(listOf("op-challenge"), store.state.value.reviewCards.map { it.op.id })
    }

    @Test fun aRefusedAnswerSaysTheServersSentenceRereadsAndKeepsTheCard() = runBlocking {
        val store = store()
        store.loadReview()
        val card = store.state.value.reviewCards.first()
        val reads = requests("GET wiki/review").size
        authority.decideStatus = 409
        assertEquals("This proposal changed since you opened it.", store.decide(card, "accept"))
        assertTrue(requests("GET wiki/review").size > reads)
        assertTrue(store.state.value.reviewCards.any { it.op.id == card.op.id })
        assertFalse(store.state.value.busy)
    }

    /** Retire on a challenge retires the entry, and the retire withdraws every op still waiting on it — the challenge
     * it answers included — so the answer records that challenge `withdrawn` (wiki-anchors.pg.spec.ts). That is the
     * Retire done, as iOS and web read it (700dfa781); `withdrawn` on any other answer still applied nothing. */
    @Test fun aChallengeAnsweredRetireIsDoneThoughTheServerRecordsTheChallengeWithdrawn() = runBlocking {
        authority.recorded = "withdrawn"
        val store = store()
        store.loadReview()
        val challenge = store.state.value.reviewCards.first { it.op.op == "challenge" }
        assertNull("the Retire went through", store.decide(challenge, "retire"))
        assertEquals("retire", body("POST wiki/changesets/$changeset/decide")["decisions"]!!.jsonArray[0].jsonObject["action"]!!.jsonPrimitive.content)
        assertFalse(store.state.value.reviewCards.any { it.op.id == challenge.op.id })
        val amend = store.state.value.reviewCards.first { it.op.op == "amend" }
        assertEquals(WikiCopy.withdrawnRefused, store.decide(amend, "accept"))
    }

    @Test fun ownerWritesCarryTheBaseRevisionAndAKeyPerPress() = runBlocking {
        val store = store()
        store.loadEntry(entryId)
        val entry = store.state.value.detail(entryId)!!.entry
        assertNull(store.edit(entry, "New title", "New line"))
        val edit = body("POST wiki/spaces/$space/changesets")
        val op = edit["ops"]!!.jsonArray.single().jsonObject
        assertEquals("amend", op["op"]!!.jsonPrimitive.content)
        assertEquals(3, op["baseRevision"]!!.jsonPrimitive.int)
        assertEquals(buildJsonObject { put("title", "New title"); put("summary", "New line") }, op["changes"])
        assertEquals(WikiCopy.editedRationale(entry.displayTitle), edit["rationale"]!!.jsonPrimitive.content)
        val firstKey = edit["idempotencyKey"]!!.jsonPrimitive.content
        assertTrue(firstKey.startsWith("wiki-edit:"))

        assertNull(store.supersede(entry, "Replacement", "Replaces it"))
        val supersede = body("POST wiki/spaces/$space/changesets")
        val replacement = supersede["ops"]!!.jsonArray.single().jsonObject
        assertEquals("supersede", replacement["op"]!!.jsonPrimitive.content)
        val draft = replacement["entry"]!!.jsonObject
        assertEquals("decision", draft["kind"]!!.jsonPrimitive.content)
        assertEquals(listOf("reader"), draft["topics"]!!.jsonArray.map { it.jsonPrimitive.content })
        // Anchors as a proposer writes them: never the `check` the server returned.
        assertEquals(buildJsonObject { put("type", "path"); put("path", "src/android/README.md") }, draft["anchors"]!!.jsonArray.single())
        assertNotEquals(firstKey, supersede["idempotencyKey"]!!.jsonPrimitive.content)

        assertNull(store.retire(entry, "Superseded by the new reader"))
        val retire = body("POST wiki/spaces/$space/changesets")["ops"]!!.jsonArray.single().jsonObject
        assertEquals("retire", retire["op"]!!.jsonPrimitive.content)
        assertEquals("Superseded by the new reader", retire["reason"]!!.jsonPrimitive.content)

        // An op the server refused inside a 200 answer is a refusal, in the server's words.
        authority.writeAnswer = """{"changesetId":"$changeset","ops":[{"seq":0,"status":"refused","reasons":[{"code":"STALE_REVISION","message":"The entry moved on."}]}]}"""
        assertEquals("The entry moved on.", store.edit(entry, "Again", "Again"))
    }

    @Test fun confirmAndRejectAnswerWhatAReviewModeAppliedThenRereadTheEntry() = runBlocking {
        val store = store()
        store.loadEntry(entryId)
        val entry = store.state.value.detail(entryId)!!.entry
        assertTrue(WikiModeLogic.canConfirm(entry.status, entry.trust))
        val reads = requests("GET wiki/entries/$entryId").size
        assertNull(store.confirm(entry))
        assertEquals(1, requests("POST wiki/entries/$entryId/confirm").size)
        assertNull(store.reject(entryId, "duplicate"))
        assertEquals(buildJsonObject { put("reason", "duplicate") }, body("POST wiki/entries/$entryId/reject"))
        assertTrue(requests("GET wiki/entries/$entryId").size >= reads + 2)
    }

    @Test fun anAbsentEntryIsMissingAndAFailedReadIsNot() = runBlocking {
        val store = store()
        authority.entryStatus = 404
        store.loadEntry(entryId)
        assertTrue(store.state.value.isMissing(entryId))
        assertFalse(store.state.value.loadFailed(entryId))
        val other = WikiStore(auth, store.handle, scope)
        authority.entryStatus = 503
        other.loadEntry(entryId)
        assertFalse(other.state.value.isMissing(entryId))
        assertTrue(other.state.value.loadFailed(entryId))
        // Once it reads, the failure is forgotten.
        authority.entryStatus = 200
        other.loadEntry(entryId)
        assertNotNull(other.state.value.detail(entryId))
        assertFalse(other.state.value.loadFailed(entryId))
    }

    @Test fun revertingARunPostsOnceAndRereadsTheRun() = runBlocking {
        val store = store()
        store.loadRun(run)
        val view = store.state.value.run(run)!!
        assertTrue(WikiModeLogic.runSummary(view).revertible)
        assertNull(store.revert(view))
        assertEquals(1, requests("POST wiki/changesets/$run/revert").size)
        assertEquals(2, requests("GET wiki/changesets/$run").size)
    }

    @Test fun linkCardsAreOneBatchedReadAndNeverAskedTwice() = runBlocking {
        val store = store()
        val refs = listOf("task" to task, "session" to session, "task" to task)
        store.noteLinkCards(refs)
        val sent = body("POST link-previews")["refs"]!!.jsonArray.map { it.jsonObject["kind"]!!.jsonPrimitive.content to it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(listOf("task" to task, "session" to session), sent)
        assertEquals("Port the reader", store.state.value.linkTitle("task", task))
        // Unavailable is the same answer for another account's, a deleted or no object: no title, the row keeps its id.
        assertNull(store.state.value.linkTitle("session", session))
        store.noteLinkCards(listOf("task" to task))
        assertEquals(1, requests("POST link-previews").size)
    }
}

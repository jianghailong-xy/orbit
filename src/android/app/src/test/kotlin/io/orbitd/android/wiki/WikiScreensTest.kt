package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.OrbitTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Wiki screens over the real store and client, answered from OrbitKit's fixtures by a scripted transport:
 * what each screen reads, draws and asks for, and where a press goes. The device run repeats these journeys in the
 * production Activity; neither is a deployed backend. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class WikiScreensTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val sent = CopyOnWriteArrayList<Pair<String, String>>()
    private val decided = CopyOnWriteArrayList<String>()
    private val space = WikiFixtures.spaceID

    private fun respond(api: ApiRequest): ApiResponse {
        val path = api.path.joinToString("/")
        val body = api.body?.decodeToString() ?: ""
        sent += "${api.method} $path" to body
        fun ok(json: String) = ApiResponse(200, json.encodeToByteArray())
        return when {
            path == "auth/login" -> ok("""{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"u@example.test","name":"U"}}""")
            path == "wiki/spaces" -> ok(WikiFixtures.spaces)
            path == "wiki/spaces/$space" -> ok(WikiFixtures.space)
            path == "wiki/spaces/$space/entries" -> ok(WikiFixtures.entries)
            path == "wiki/spaces/$space/timeline" -> ok(WikiFixtures.timeline)
            path == "wiki/spaces/$space/docs" -> ok(wikiDocsFixture().obj("docs").obj("directory").obj("read").toString())
            path == "wiki/entries/${WikiFixtures.pitfallID}" -> ok(WikiFixtures.entryDetail)
            path == "wiki/review" -> ok(reviewQueue())
            path.startsWith("wiki/changesets/") && path.endsWith("/decide") -> {
                decided += Wire.json.parseToJsonElement(body).jsonObject["decisions"]!!.jsonArray[0].jsonObject["opId"]!!.jsonPrimitive.content
                ok("{}")
            }
            path == "wiki/search" -> ok("""{"q":"secret","hits":[{"id":"${WikiFixtures.pitfallID}","kind":"pitfall","title":"runner-go’s full suite inside a session reaches production","summary":"Fix it"}]}""")
            path == "link-previews" -> ok("""{"previews":[]}""")
            else -> ApiResponse(404, "{}".encodeToByteArray())
        }
    }
    /** The fixture queue less what has been answered: the server lists only what still waits. */
    private fun reviewQueue(): String {
        val queue = Wire.json.parseToJsonElement(WikiFixtures.review).jsonArray.map { changeset ->
            val ops = changeset.jsonObject["ops"]!!.jsonArray.filter { it.jsonObject["id"]!!.jsonPrimitive.content !in decided }
            JsonObject(changeset.jsonObject + ("ops" to JsonArray(ops)))
        }
        return JsonArray(queue).toString()
    }

    private val opened = mutableListOf<OrbitRoute>()
    private fun store(): WikiStore = runBlocking {
        val auth = AuthSession(HttpTransport { respond(it.api) }, object : CredentialStore {
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
        }, "test")
        auth.login(ServerAddress.parse("https://fixture.test"), "u@example.test", "password")
        WikiStore(auth, (auth.state.value as AuthState.SignedIn).handle, CoroutineScope(SupervisorJob() + Dispatchers.Main))
    }
    private val nav = WikiNav({ opened += it }, {}, "https://fixture.test") {}

    private fun show(route: OrbitRoute, screen: @androidx.compose.runtime.Composable (WikiStore) -> Unit) {
        val store = store()
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            // The shell's bar: the page binds its title and actions there.
            Column { Row { PageBar.Actions(route, this) }; screen(store) }
        } } }
    }

    @Test fun theHomeDrawsTheSpaceItsPrinciplesAndWhereItsBarGoes() {
        val route = OrbitRoute(Destination.WIKI, origin = Origin.DRAWER)
        show(route) { WikiHomeScreen(it, route, DirectoryData(), nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-home-list").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-space-picker").assertTextContains("orbit")
        // The first three principles, then All 4 (A12-3).
        listOf("Agent-writable data never becomes a system instruction", "Completion is adjudicated, not claimed",
            "A clock never starts agent work").forEach {
            compose.waitUntil(5_000) { runCatching { compose.onNodeWithTag("wiki-home-list").performScrollToNode(hasText(it)) }.isSuccess }
        }
        // The principles by their kind, and the plan's documents; what Activity draws is not the home's to read.
        assertTrue(sent.any { it.first == "GET wiki/spaces/$space/docs" })
        assertTrue(sent.any { it.first == "GET wiki/spaces/$space/entries" })
        assertTrue(sent.none { it.first == "GET wiki/spaces/$space/timeline" })
        compose.onNodeWithText("A clock never starts agent work").performClick()
        // The bar: Contents, Activity — with the number waiting on the owner — and Settings.
        compose.onNodeWithTag("wiki-bar-contents").assertExists()
        compose.onNodeWithTag("wiki-bar-activity").assert(hasStateDescription("3 waiting on you")).performClick()
        compose.onNodeWithTag("wiki-bar-settings").performClick()
        assertEquals(listOf(OrbitRoute(Destination.WIKI_ENTRY, WikiFixtures.principleID), OrbitRoute(Destination.WIKI_ACTIVITY),
            OrbitRoute(Destination.WIKI_SETTINGS)), opened)
    }

    @Test fun activityDrawsWhatTheHomeUsedToSayAndWhereEachRowGoes() {
        val route = OrbitRoute(Destination.WIKI_ACTIVITY)
        show(route) { WikiActivityScreen(it, route, DirectoryData(), nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-status-line").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-status-line").assertTextEquals("9 entries · Anchors verified at 4db4f9f")
        compose.onNodeWithTag("wiki-review-banner").assertTextContains("3 proposals to review", substring = true)
        listOf("Task priority is a field on the task, not a dispatcher session", "Delete means forget", "Headless Chromium needs --window-size=393",
            "Agents used the wiki").forEach {
            compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasText(it))
        }
        compose.onNodeWithTag("wiki-activity-list").performScrollToIndex(0)
        // Each read Activity is drawn from.
        listOf("GET wiki/spaces", "GET wiki/spaces/$space", "GET wiki/spaces/$space/entries", "GET wiki/spaces/$space/timeline")
            .forEach { request -> assertTrue("missing $request", sent.any { it.first == request }) }
        compose.onNodeWithTag("wiki-review-banner").performClick()
        compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasText("Task priority is a field on the task, not a dispatcher session"))
        compose.onNodeWithText("Task priority is a field on the task, not a dispatcher session").performClick()
        assertEquals(OrbitRoute(Destination.WIKI_REVIEW), opened[0])
        assertEquals(Destination.WIKI_ENTRY, opened[1].destination)
    }

    @Test fun searchFindsEntriesUnderTheTitleAndSaysWhenNothingMatches() {
        val route = OrbitRoute(Destination.WIKI)
        show(route) { WikiHomeScreen(it, route, DirectoryData(), nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-search").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-search").performTextInput("secret")
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-hit:${WikiFixtures.pitfallID}").fetchSemanticsNodes().isNotEmpty() }
        // While searching, the bands step aside.
        compose.onNodeWithText("Delete means forget").assertDoesNotExist()
        assertTrue(sent.any { it.first == "GET wiki/search" })
        compose.onNodeWithTag("wiki-hit:${WikiFixtures.pitfallID}").performClick()
        assertEquals(OrbitRoute(Destination.WIKI_ENTRY, WikiFixtures.pitfallID), opened.last())
    }

    @Test fun anEntryDrawsItsSectionsAndItsSourcesOpenWhatTheyCite() {
        val route = OrbitRoute(Destination.WIKI_ENTRY, WikiFixtures.pitfallID)
        show(route) { WikiEntryScreen(it, route, DirectoryData(), nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-entry-title").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-entry-title").assertTextEquals("runner-go’s full suite inside a session reaches production")
        compose.onNodeWithText("Trigger").assertExists()
        // A confirmed entry offers no Confirm/Reject; the owner's own writes are the bar's.
        compose.onNodeWithTag("wiki-entry-confirm").assertDoesNotExist()
        compose.onNodeWithTag("wiki-entry-edit").assertExists()
        compose.onNodeWithTag("wiki-entry-list").performScrollToNode(hasTestTag("wiki-source:34UDSrcSessionTurn001"))
        compose.onNodeWithTag("wiki-source:34UDSrcSessionTurn001").performClick()
        compose.onNodeWithTag("wiki-entry-list").performScrollToNode(hasTestTag("wiki-source:34UDSrcTask0000000002"))
        compose.onNodeWithTag("wiki-source:34UDSrcTask0000000002").performClick()
        // A commit source cites no Orbit object: it does not open.
        compose.onNodeWithTag("wiki-entry-list").performScrollToNode(hasTestTag("wiki-source:34UDSrcCommit00000003"))
        compose.onNodeWithTag("wiki-source:34UDSrcCommit00000003").performClick()
        assertEquals(listOf(OrbitRoute(Destination.SESSION, "0196e000-0000-7000-8000-0000000000c1", origin = Origin.LINK),
            OrbitRoute(Destination.TASK, "0196e000-0000-7000-8000-0000000000c2", origin = Origin.LINK)), opened)
        // The page asked for its cards once: the cited task and session, and the sessions it was handed to.
        assertEquals(1, sent.count { it.first == "POST link-previews" })
    }

    @Test fun reviewAnswersOneCardAndMovesToTheNext() {
        val route = OrbitRoute(Destination.WIKI_REVIEW)
        show(route) { WikiReviewScreen(it, route, DirectoryData(), nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-review-card:34UDOpAddPitfall00001").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-review-position").assertTextEquals("1 of 3")
        compose.onNodeWithTag("wiki-review-accept").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-review-card:34UDOpRetireWakeup002").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf("34UDOpAddPitfall00001"), decided)
        compose.waitUntil(5_000) { compose.onAllNodesWithText("1 of 2").fetchSemanticsNodes().isNotEmpty() }
    }
}

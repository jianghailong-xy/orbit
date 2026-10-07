package io.orbitd.android.wiki

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.util.Log
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/** The refusal the app must show when the owner accepts a proposal whose entry moved on (the server records the
 * op `conflict` and applies nothing): "Nothing was applied: the entry changed after this was proposed." Before the
 * review-1 fix (9095a638f) the app said "Accepted" instead. */
private const val CONFLICT_REFUSED = WikiCopy.conflictRefused

/** What the space page says to an account the space is not theirs ("That space is not available."), and its tag. */
private const val SPACE_UNAVAILABLE = WikiCopy.spaceUnavailable
private const val SPACE_UNAVAILABLE_TAG = "wiki-space-unavailable"

/** The app's own words this suite looks for. */
private const val ACCEPTED = WikiCopy.decidedAccepted
private const val SAVED = WikiCopy.saved
private const val ENTRY_GONE = WikiCopy.noEntrySelected

/**
 * A12 against a real Orbit server: the isolated stack of `src/android/scripts/a12-stack` (the apiserver of
 * 0f98546a5 with its own PostgreSQL and runner, on the host's loopback, reached through `adb reverse tcp:3712`),
 * seeded through its HTTP API with a real owner account and a second account. The production Activity,
 * AuthSession and navigation open each journey from its link; every journey acts through the screens, then reads
 * the server back over HTTP with the acting account's own token and asserts what the server kept. What it read and
 * checked is written beside its captures (`<journey>-server.json`, `<journey>-checks.txt`).
 *
 * Instrumentation arguments (all from the stack's seed.json and accounts.json, see `scripts/a12-stack/live.sh`):
 * a12Server, a12OwnerEmail, a12OwnerPassword, a12OtherEmail, a12OtherPassword, a12Space, a12SpaceSlug,
 * a12SearchEntry, a12SearchQuery, a12FreshChangeset, a12FreshOp, a12FreshEntry, a12StaleChangeset, a12StaleOp,
 * a12StaleEntry, a12EditEntry, a12Watch, a12Task, a12RunChangeset, a12RunEntry. Skipped without a12Server.
 *
 * Each journey signs in with `AuthSession.login` before its Activity starts and signs out only after the scenario
 * is closed (see the KDoc on `journey` in [WikiWatchDeviceTest]: under the Compose test rule a live composition
 * can recompose on AuthSession's thread). Journeys that decide or stop something are one-shot: a second run needs
 * a freshly seeded stack (`setup.sh reset`), and each checks its precondition on the server first.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class WikiWatchLiveTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private fun arg(name: String) = args.getString(name) ?: error("missing instrumentation argument $name")
    private val output get() = File(app.filesDir, "a12-live").also { it.mkdirs() }
    private lateinit var server: String
    private lateinit var owner: Account
    private lateinit var other: Account

    private class Account(val role: String, val email: String, val password: String) { var token: String? = null }

    /** What the running journey read from the server, in order, and every check it made. */
    private val readBacks = linkedMapOf<String, JsonElement>()
    private val checks = mutableListOf<String>()

    @Before fun stack() {
        assumeTrue("Needs the isolated A12 stack (instrumentation argument a12Server)", args.getString("a12Server") != null)
        server = arg("a12Server").trimEnd('/')
        owner = Account("owner", arg("a12OwnerEmail"), arg("a12OwnerPassword"))
        other = Account("other", arg("a12OtherEmail"), arg("a12OtherPassword"))
    }

    // MARK: the server, read with the acting account's own token

    private class Reply(val status: Int, val body: JsonElement?) {
        val obj: JsonObject? get() = body as? JsonObject
    }

    private fun http(method: String, path: String, token: String?, body: JsonElement? = null): Reply =
        (URL("$server/api/$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method; useCaches = false
            // One connection per read: a check must never fail on a pooled socket the server has closed.
            setRequestProperty("Connection", "close")
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                doOutput = true; setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray()) }
            }
            try {
                val status = responseCode
                val text = (if (status in 200..299) inputStream else errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                Reply(status, text.takeIf { it.isNotBlank() }?.let { runCatching { Wire.json.parseToJsonElement(it) }.getOrNull() })
            } finally { disconnect() }
        }

    private fun token(account: Account): String = account.token ?: run {
        val reply = http("POST", "auth/login", null, buildJsonObject { put("email", account.email); put("password", account.password) })
        check(reply.status in 200..299) { "server: ${account.email} could not sign in (${reply.status})" }
        reply.obj!!.getValue("accessToken").jsonPrimitive.content.also { account.token = it }
    }

    private fun get(path: String, account: Account): Reply {
        val reply = http("GET", path, token(account))
        if (reply.status != 401) return reply
        account.token = null
        return http("GET", path, token(account))
    }

    private fun record(what: String, account: Account, path: String, reply: Reply) {
        readBacks["${readBacks.size + 1}. $what"] = buildJsonObject {
            put("as", account.role); put("request", "GET /api/$path"); put("status", reply.status); put("at", Instant.now().toString())
            reply.body?.let { put("body", it) }
        }
    }

    /** One read, kept for the journey's server file. */
    private fun read(what: String, account: Account, path: String): Reply = get(path, account).also { record(what, account, path, it) }

    /** One read that must answer 200, as an object. */
    private fun readObject(what: String, account: Account, path: String): JsonObject {
        val reply = read(what, account, path)
        ok("server: $what (GET /api/$path answered ${reply.status})", reply.status == 200 && reply.obj != null)
        return reply.obj!!
    }

    /** A write the screens made, read back until [holds] (or [timeoutMs] passes); the last read is kept and checked. */
    private fun eventually(what: String, account: Account, path: String, timeoutMs: Long = 25_000, holds: (Reply) -> Boolean): Reply {
        val until = System.currentTimeMillis() + timeoutMs
        while (true) {
            val reply = get(path, account)
            val held = runCatching { holds(reply) }.getOrDefault(false)
            if (held || System.currentTimeMillis() > until) {
                record(what, account, path, reply)
                ok("server: $what", held)
                return reply
            }
            // The pages' own timers run on the test's clock: it moves with real time while the server is polled.
            compose.mainClock.advanceTimeBy(250); compose.waitForIdle(); Thread.sleep(500)
        }
    }

    private fun note(line: String) { checks += "${Instant.now()} $line"; Log.i("A12", line) }
    private fun ok(what: String, holds: Boolean) { note((if (holds) "PASS " else "FAIL ") + what); assertTrue(what, holds) }

    private fun JsonObject.s(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.i(key: String) = (this[key] as? JsonPrimitive)?.intOrNull
    private fun JsonObject.o(key: String) = this[key] as? JsonObject
    private fun JsonObject.a(key: String) = (this[key] as? JsonArray)?.map { it.jsonObject }.orEmpty()

    /** The decision the server holds for one op of a changeset. */
    private fun decisionOf(changeset: JsonObject?, op: String) = changeset?.a("ops")?.firstOrNull { ObjectId.same(it.s("id"), op) }?.s("decision")

    // MARK: the screens

    /** A node whose tag is [prefix] followed by [id], in either spelling of the id (the server answers base62). */
    private fun tagFor(prefix: String, id: String) = SemanticsMatcher("testTag $prefix<$id>") { node ->
        val tag = node.config.getOrNull(SemanticsProperties.TestTag) ?: return@SemanticsMatcher false
        tag.startsWith(prefix) && ObjectId.same(tag.removePrefix(prefix), id)
    }
    /** A watch page's own tags, `watch-detail:<id>` and the bar's `watch:<id>:<control>`, in either spelling of the id. */
    private fun watchTag(id: String, control: String? = null) = SemanticsMatcher("watch tag <$id> ${control.orEmpty()}") { node ->
        val tag = node.config.getOrNull(SemanticsProperties.TestTag) ?: return@SemanticsMatcher false
        if (control == null) tag.startsWith("watch-detail:") && ObjectId.same(tag.removePrefix("watch-detail:"), id)
        else tag.startsWith("watch:") && tag.endsWith(":$control") && ObjectId.same(tag.removePrefix("watch:").removeSuffix(":$control"), id)
    }
    private fun shows(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun showsText(text: String) = shows(hasText(text, substring = true))
    private fun awaitNode(what: String, matcher: SemanticsMatcher, timeout: Long = 25_000) {
        try { compose.waitUntil(timeout) { compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() } }
        catch (e: ComposeTimeoutException) { throw AssertionError("$what did not show within $timeout ms", e) }
    }
    private fun await(text: String, timeout: Long = 25_000) = awaitNode("\"$text\"", hasText(text, substring = true), timeout)
    private fun awaitTag(tag: String, timeout: Long = 25_000) = awaitNode("tag $tag", hasTestTag(tag), timeout)
    /** Waits until one of [matchers] shows; false when none did within [timeout]. */
    private fun awaitAny(timeout: Long, vararg matchers: SemanticsMatcher): Boolean =
        runCatching { compose.waitUntil(timeout) { matchers.any(::shows) } }.isSuccess
    private fun press(matcher: SemanticsMatcher, what: String = matcher.description) {
        try { compose.waitUntil(20_000) { compose.onAllNodes(matcher and isEnabled()).fetchSemanticsNodes().isNotEmpty() } }
        catch (e: ComposeTimeoutException) { throw AssertionError("$what was not there to press within 20 s", e) }
        val node = compose.onAllNodes(matcher).onFirst()
        // At a large font a control can sit below its page's fold: scrolled into view first, as a person would.
        if (compose.onAllNodes(matcher and hasAnyAncestor(hasScrollAction())).fetchSemanticsNodes().isNotEmpty()) node.performScrollTo()
        node.performClick()
    }
    private fun press(tag: String) = press(hasTestTag(tag), "tag $tag")
    /** A row of a lazy list: scrolled into view first, then pressed. */
    private fun pressIn(list: String, matcher: SemanticsMatcher) {
        awaitTag(list)
        try { compose.waitUntil(20_000) { runCatching { compose.onNodeWithTag(list).performScrollToNode(matcher) }.isSuccess } }
        catch (e: ComposeTimeoutException) { throw AssertionError("${matcher.description} is not in $list", e) }
        press(matcher)
    }

    private fun capture(name: String) {
        // Let the frame on screen catch up with the tree the test just read.
        compose.waitForIdle(); Thread.sleep(500)
        // A dialog or a sheet is a second root: every root's tree is kept.
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText((0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        // UiAutomation answers null when the device is too starved to take one in time: asked again, and a capture still
        // without one says so beside its semantics tree instead of failing the journey.
        val bitmap = (1..3).firstNotNullOfOrNull { attempt -> instrument.uiAutomation.takeScreenshot() ?: null.also { Thread.sleep(1_000L * attempt) } }
        if (bitmap == null) { File(output, "$name-screenshot-missing.txt").writeText("takeScreenshot returned null 3 times\n"); return }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }

    private fun launch(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** A cold start from [link] as [who], then [block]. The account signs in before the Activity starts and signs out
     * after it is gone; what failed is written down before the scenario closes, and the journey's reads and checks
     * whatever happens. */
    private fun journey(name: String, who: Account, link: String, block: (ActivityScenario<MainActivity>) -> Unit) {
        readBacks.clear(); checks.clear()
        instrument.sendStatus(0, Bundle().apply { putString("a12_pid", Process.myPid().toString()) })
        File(output, "$name-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server (isolated A12 stack)\n" +
            "account=${who.role} ${who.email}\nlink=$link\nlogin=before-launch\nstarted=${Instant.now()}\n")
        // Restore is the Activity's to start; it is idempotent, so the journey starts it, then signs out.
        runBlocking { app.session.restore(); app.session.logout() }
        assertTrue(app.session.state.value is AuthState.SignedOut)
        runBlocking { app.session.login(ServerAddress.parse(server, true), who.email, who.password) }
        try {
            ActivityScenario.launch<MainActivity>(launch(link)).use { scenario ->
                try {
                    compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                    block(scenario)
                    File(output, "$name-result.txt").writeText("PASS · live stack $server\n")
                } catch (error: Throwable) {
                    // Written down first: a crash while the scenario closes would otherwise lose what failed.
                    File(output, "$name-failure.txt").writeText(error.stackTraceToString())
                    Log.e("A12", "live journey $name failed", error)
                    runCatching { capture("$name-failed") }
                    throw error
                }
            }
        } finally {
            File(output, "$name-server.json").writeText(JsonObject(readBacks).toString())
            File(output, "$name-checks.txt").writeText(checks.joinToString("\n", postfix = "\n"))
            runBlocking { app.session.logout() }
        }
    }

    /** Waits on the Review page for the card of [op], paging forward (the queue is newest first). */
    private fun showReviewCard(op: String) {
        awaitTag("wiki-review-page")
        val card = tagFor("wiki-review-card:", op)
        val until = System.currentTimeMillis() + 25_000
        while (!shows(card)) {
            if (System.currentTimeMillis() > until) throw AssertionError("the card of op $op is not on Review")
            if (shows(hasTestTag("wiki-review-next") and isEnabled())) press("wiki-review-next")
            else { compose.mainClock.advanceTimeBy(250); compose.waitForIdle(); Thread.sleep(250) }
        }
    }

    /** The Accepted toast, as opposed to any other line that mentions accepting. */
    private val acceptedToast = hasText(ACCEPTED) and hasAnyAncestor(hasTestTag("wiki-toast"))

    // MARK: the owner's journeys

    /** `orbit://wiki/<space>` opens the seeded space's home; search under the title finds a seeded entry, which opens. */
    @Test fun j1OwnerOpensTheSpaceSearchesAndOpensAnEntry() {
        val space = arg("a12Space"); val entry = arg("a12SearchEntry"); val query = arg("a12SearchQuery")
        journey("j1-space-search-entry", owner, "orbit://wiki/$space") { _ ->
            val slug = readObject("the space as the owner holds it", owner, "wiki/spaces/$space").s("slug")!!
            val title = readObject("the entry the search should find", owner, "wiki/entries/$entry").s("title")!!
            val hits = readObject("the server's own search", owner, "wiki/search?q=$query&space=$space").a("hits")
            ok("server: the search finds the entry", hits.any { ObjectId.same(it.s("id"), entry) })
            awaitTag("wiki-status-line")
            compose.onNodeWithTag("wiki-space-picker").assertTextContains(slug)
            ok("the home shows the seeded space ($slug)", true)
            capture("j1-space-home")
            compose.onNodeWithTag("wiki-search").performTextInput(query)
            awaitNode("the search hit", tagFor("wiki-hit:", entry))
            capture("j1-search-hits")
            press(tagFor("wiki-hit:", entry), "the search hit")
            awaitTag("wiki-entry-title")
            compose.onNodeWithTag("wiki-entry-title").assertTextEquals(title)
            ok("the entry page opens on \"$title\"", true)
            capture("j1-entry")
        }
    }

    /** Review: Accept on the fresh proposal records `accepted` on the server, and its entry is applied. */
    @Test fun j2OwnerAcceptsTheFreshProposal() {
        val space = arg("a12Space"); val changeset = arg("a12FreshChangeset"); val op = arg("a12FreshOp"); val entry = arg("a12FreshEntry")
        journey("j2-review-accept-fresh", owner, "orbit://wiki/$space") { _ ->
            val before = readObject("the fresh proposal before", owner, "wiki/changesets/$changeset")
            ok("precondition: the fresh op is pending (else the stack needs setup.sh reset)", decisionOf(before, op) == "pending")
            press("wiki-review-banner")
            showReviewCard(op)
            capture("j2-review-card")
            press("wiki-review-accept")
            val toast = awaitAny(20_000, acceptedToast)
            capture("j2-after-accept")
            eventually("the fresh op's decision is accepted", owner, "wiki/changesets/$changeset") { decisionOf(it.obj, op) == "accepted" }
            eventually("the proposed entry is applied: active and confirmed", owner, "wiki/entries/$entry") {
                it.obj?.s("status") == "active" && it.obj?.s("trust") == "confirmed"
            }
            ok("the app says Accepted", toast)
        }
    }

    /** Review: Accept on a proposal whose entry moved on — the server records `conflict` and applies nothing, and the
     * app must say so rather than "Accepted" (before the review-1 fix 9095a638f it said "Accepted"). */
    @Test fun j3OwnerAcceptsTheStaleProposalAndIsRefused() {
        val space = arg("a12Space"); val changeset = arg("a12StaleChangeset"); val op = arg("a12StaleOp"); val entry = arg("a12StaleEntry")
        journey("j3-review-accept-stale", owner, "orbit://wiki/$space") { _ ->
            val before = readObject("the stale proposal before", owner, "wiki/changesets/$changeset")
            ok("precondition: the stale op is pending (else the stack needs setup.sh reset)", decisionOf(before, op) == "pending")
            val proposedAt = before.a("ops").first { ObjectId.same(it.s("id"), op) }.i("baseRevision")
            val entryBefore = readObject("the entry before", owner, "wiki/entries/$entry")
            val revision = entryBefore.i("currentRevision"); val summary = entryBefore.s("summary")
            ok("precondition: the entry moved on past the op's base revision ($proposedAt < $revision)",
                proposedAt != null && revision != null && proposedAt < revision)
            press("wiki-review-banner")
            showReviewCard(op)
            capture("j3-review-card")
            press("wiki-review-accept")
            val answered = awaitAny(20_000, hasText(CONFLICT_REFUSED, substring = true), acceptedToast)
            val refused = showsText(CONFLICT_REFUSED); val accepted = shows(acceptedToast)
            note("after Accept the app shows: refusal=$refused accepted-toast=$accepted (any answer within 20 s: $answered)")
            capture("j3-after-accept")
            eventually("the stale op's decision is conflict", owner, "wiki/changesets/$changeset") { decisionOf(it.obj, op) == "conflict" }
            eventually("the entry is unchanged: revision $revision and its summary", owner, "wiki/entries/$entry") {
                it.obj?.i("currentRevision") == revision && it.obj?.s("summary") == summary
            }
            ok("the app does not say Accepted for a conflict", !accepted)
            ok("the app says \"$CONFLICT_REFUSED\"", refused)
        }
    }

    /** The entry's Edit writes the new title and summary as one revision the server reads back. */
    @Test fun j4OwnerEditsAnEntry() {
        val entry = arg("a12EditEntry")
        journey("j4-entry-edit", owner, "orbit-wiki:$entry") { _ ->
            val before = readObject("the entry before", owner, "wiki/entries/$entry")
            val revision = before.i("currentRevision")!!; val title = before.s("title")!!
            val newTitle = "$title (edited on Android)"; val newSummary = "Edited on Android against the live A12 stack, then read back from the server."
            awaitTag("wiki-entry-title")
            compose.onNodeWithTag("wiki-entry-title").assertTextEquals(title)
            capture("j4-entry")
            press("wiki-entry-edit")
            awaitTag("wiki-entry-form-summary")
            compose.onNodeWithTag("wiki-entry-form-title").performTextReplacement(newTitle)
            compose.onNodeWithTag("wiki-entry-form-summary").performTextReplacement(newSummary)
            capture("j4-edit-form")
            press("wiki-entry-form-save")
            val saved = awaitAny(20_000, hasText(SAVED) and hasAnyAncestor(hasTestTag("wiki-toast")))
            capture("j4-saved")
            eventually("the entry is at revision ${revision + 1} with the new title and summary", owner, "wiki/entries/$entry?include=history") {
                it.obj?.i("currentRevision") == revision + 1 && it.obj?.s("title") == newTitle && it.obj?.s("summary") == newSummary
            }
            ok("the app says Saved", saved)
            awaitNode("the new title on the page", hasTestTag("wiki-entry-title") and hasText(newTitle))
            capture("j4-entry-after")
        }
    }

    /** Wiki settings: the review mode is written as the owner picks it, and each pick is what the server reads back. */
    @Test fun j5OwnerChangesTheReviewMode() {
        val space = arg("a12Space")
        journey("j5-settings-review-mode", owner, "orbit://wiki/$space") { _ ->
            val before = readObject("the space's settings before", owner, "wiki/spaces/$space").o("settings")!!
            ok("precondition: the space is Manual", before.s("reviewMode") == "manual")
            awaitTag("wiki-status-line")
            press("wiki-bar-settings")
            awaitTag("wiki-settings-page")
            capture("j5-settings-manual")
            press("wiki-settings-mode:tiered")
            eventually("reviewMode is tiered, the other settings as they were", owner, "wiki/spaces/$space") {
                val after = it.obj?.o("settings")
                after != null && after.s("reviewMode") == "tiered" && after["push"] == before["push"] &&
                    after["autoAcceptReinforce"] == before["autoAcceptReinforce"]
            }
            capture("j5-settings-tiered")
            press("wiki-settings-mode:manual")
            eventually("reviewMode is manual again", owner, "wiki/spaces/$space") { it.obj?.o("settings")?.s("reviewMode") == "manual" }
            capture("j5-settings-manual-again")
        }
    }

    /** `orbit://watch/<id>`: Pause, Resume and Stop (after its confirmation) are each what the server reads back. */
    @Test fun j6OwnerPausesResumesAndStopsTheWatch() {
        val watch = arg("a12Watch")
        journey("j6-watch-controls", owner, "orbit://watch/$watch") { _ ->
            val before = readObject("the watch before", owner, "watches/$watch")
            ok("precondition: the watch is ACTIVE (else the stack needs setup.sh reset)", before.s("state") == "ACTIVE")
            awaitNode("the watch's page", watchTag(watch))
            capture("j6-watch-active")
            press(watchTag(watch, "WATCH_PAUSE"), "Pause")
            eventually("the watch is PAUSED", owner, "watches/$watch") { it.obj?.s("state") == "PAUSED" }
            awaitNode("Resume", watchTag(watch, "WATCH_RESUME"))
            capture("j6-watch-paused")
            press(watchTag(watch, "WATCH_RESUME"), "Resume")
            eventually("the watch is ACTIVE again", owner, "watches/$watch") { it.obj?.s("state") == "ACTIVE" }
            awaitNode("Pause", watchTag(watch, "WATCH_PAUSE"))
            press(watchTag(watch, "WATCH_CANCEL"), "Stop")
            await("Stop watching?")
            capture("j6-watch-stop-confirmation")
            ok("server: nothing is sent before the confirmation", read("the watch while Stop asks", owner, "watches/$watch").obj?.s("state") == "ACTIVE")
            press("watch-stop-confirm")
            eventually("the watch is CANCELLED", owner, "watches/$watch") { it.obj?.s("state") == "CANCELLED" }
            await("Stopped")
            ok("an ended watch keeps no controls", !shows(watchTag(watch, "WATCH_PAUSE")) && !shows(watchTag(watch, "WATCH_RESUME")) &&
                !shows(watchTag(watch, "WATCH_CANCEL")))
            capture("j6-watch-stopped")
        }
    }

    // MARK: the other account, on the owner's objects

    /** Every title and the slug of the owner's this run can name, as the owner's server holds them — none of which
     * may reach the other account's screen. */
    private fun ownersWords(): List<String> {
        val space = arg("a12Space")
        val entries = get("wiki/spaces/$space/entries?limit=200", owner).body as? JsonArray
        val titles = entries?.mapNotNull { (it as? JsonObject)?.s("title") }.orEmpty()
        val task = get("tasks/${arg("a12Task")}", owner).obj?.s("title")
        val words = (titles + listOfNotNull(task) + arg("a12SpaceSlug")).distinct()
        check(words.size > 3) { "could not read the owner's titles from the server" }
        return words
    }
    private fun ownersWordsOnScreen(words: List<String>) = words.filter(::showsText)

    /** `orbit-wiki:<owner's entry>` as the other account: the entry page withdraws, and the server answers 404. */
    @Test fun j7aOtherAccountOpensTheOwnersEntry() {
        val entry = arg("a12EditEntry")
        journey("j7a-other-owners-entry", other, "orbit-wiki:$entry") { _ ->
            val words = ownersWords()
            ok("server: the owner's entry is a 404 to the other account", read("the owner's entry as the other account", other, "wiki/entries/$entry").status == 404)
            await(ENTRY_GONE)
            compose.onNodeWithTag("wiki-entry-title").assertDoesNotExist()
            capture("j7a-entry-withdrawn")
            val leaked = ownersWordsOnScreen(words)
            ok("none of the owner's content is on screen (saw: $leaked)", leaked.isEmpty())
        }
    }

    /** `orbit://wiki/<owner's space>` as the other account: the page says the space is not available (before the
     * review-1 fix 9095a638f it showed the account's own space instead), and the server answers 404. */
    @Test fun j7bOtherAccountOpensTheOwnersSpace() {
        val space = arg("a12Space")
        journey("j7b-other-owners-space", other, "orbit://wiki/$space") { _ ->
            val words = ownersWords()
            ok("server: the owner's space is a 404 to the other account", read("the owner's space as the other account", other, "wiki/spaces/$space").status == 404)
            val listed = read("the other account's spaces", other, "wiki/spaces").body as? JsonArray
            ok("server: the other account's spaces do not include the owner's",
                listed != null && listed.none { ObjectId.same((it as? JsonObject)?.s("id"), space) })
            val withdrawn = awaitAny(20_000, hasTestTag(SPACE_UNAVAILABLE_TAG), hasText(SPACE_UNAVAILABLE, substring = true))
            // Whatever the page settled on, it is drawn before anything is asserted.
            awaitAny(10_000, hasTestTag("wiki-status-line"), hasText(SPACE_UNAVAILABLE, substring = true))
            capture("j7b-space")
            val leaked = ownersWordsOnScreen(words)
            ok("none of the owner's content is on screen (saw: $leaked)", leaked.isEmpty())
            ok("the page says \"$SPACE_UNAVAILABLE\"", withdrawn)
        }
    }

    /** `orbit://watch/<owner's watch>` as the other account: Watch not found, and the server answers 404. */
    @Test fun j7cOtherAccountOpensTheOwnersWatch() {
        val watch = arg("a12Watch")
        journey("j7c-other-owners-watch", other, "orbit://watch/$watch") { _ ->
            val words = ownersWords()
            ok("server: the owner's watch is a 404 to the other account", read("the owner's watch as the other account", other, "watches/$watch").status == 404)
            awaitTag("watch-not-found")
            await("Watch not found")
            ok("no record of the watch is drawn", !shows(watchTag(watch)))
            capture("j7c-watch-not-found")
            val leaked = ownersWordsOnScreen(words)
            ok("none of the owner's content is on screen (saw: $leaked)", leaked.isEmpty())
        }
    }

    // MARK: a run

    /** Recently changed → the run the review mode applied (seeded through the agent door in a Tiered space) → Revert
     * run…, which asks first: the server then holds nothing of the run, and its entry is no longer active. */
    @Test fun j8OwnerRevertsARun() {
        val space = arg("a12Space"); val run = arg("a12RunChangeset"); val entry = arg("a12RunEntry")
        journey("j8-run-revert", owner, "orbit://wiki/$space") { _ ->
            val before = readObject("the run before", owner, "wiki/changesets/$run")
            ok("precondition: the run is revertible (else the stack needs setup.sh reset)", before["revertible"]?.jsonPrimitive?.booleanOrNull == true)
            pressIn("wiki-home-list", tagFor("wiki-run:", run))
            awaitTag("wiki-run-title")
            capture("j8-run-page")
            press("wiki-run-revert")
            await("Revert this run?")
            capture("j8-run-revert-confirmation")
            ok("server: nothing is sent before the confirmation", read("the run while Revert asks", owner, "wiki/changesets/$run").obj?.get("revertible")?.jsonPrimitive?.booleanOrNull == true)
            press("wiki-run-revert-confirm")
            eventually("the run has nothing left to revert", owner, "wiki/changesets/$run") { it.obj?.get("revertible")?.jsonPrimitive?.booleanOrNull == false }
            eventually("the run's entry is no longer active", owner, "wiki/entries/$entry") { it.obj?.s("status") != null && it.obj?.s("status") != "active" }
            // Reverted: the page closes back to the home.
            awaitTag("wiki-status-line")
            capture("j8-run-reverted")
        }
    }
}

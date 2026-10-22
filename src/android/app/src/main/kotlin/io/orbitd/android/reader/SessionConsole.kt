package io.orbitd.android.reader

import androidx.compose.runtime.*
import io.orbitd.android.OrbitApplication
import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.CursorRuntime
import io.orbitd.android.composer.DraftTarget
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.composer.ProviderOption
import io.orbitd.android.composer.threeTries
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.EngineAccounts
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.accountSnapshotReported
import io.orbitd.android.management.cursorUsageLimit
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.serialization.json.*

/**
 * What a card in the conversation acts through (iOS's `ConsoleModel`, as the Antigravity repair card reads it): the session's
 * freshest detail, its runner and the account's providers as last read, its composer, and the runner's page it sends the reader
 * to. Absent in a render with no session behind it, where those cards fall back to the runtime's own sentence.
 */
@Stable
internal class SessionConsole(val app: OrbitApplication, val handle: SessionHandle, val sessionId: String, val composer: ComposerModel,
    private val scope: CoroutineScope, private val reloadDetail: suspend () -> Unit, val openRunner: (runner: String, engine: String) -> Unit,
    val openSession: (String) -> Unit, val openDraft: (workspaceId: String) -> Unit = {}) {
    val management = ManagementApi(app.session, handle, scope)
    /** The session as last read: the worktree bar's poll, or the store's snapshot. */
    var detail by mutableStateOf<JsonObject?>(null)
    var runner by mutableStateOf<JsonObject?>(null); private set
    var providers by mutableStateOf<List<JsonObject>>(emptyList()); private set
    /** An install this console asked for is on its way to the server. */
    var installing by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)

    val provider get() = detail?.string("provider").orEmpty()
    val runnerId get() = detail?.string("assignedRunnerId") ?: detail?.string("runnerId")
    val runnerName get() = runner?.let(RunnerPage::displayName)?.takeIf { it.isNotEmpty() }
        ?: (detail?.get("assignedRunner") as? JsonObject)?.let { it.string("displayName") ?: it.string("name") }
    val runnerVersion get() = runner?.string("version") ?: (detail?.get("assignedRunner") as? JsonObject)?.string("version")
    /** The engine this session runs on for good: the one it records, else the one its provider ran on before engines were. */
    val engine get() = ProviderEngines.sessionEngine(detail?.string("engine"), provider, providers)
    /** The key this session runs on, as a card about a key its vendor rejected names it (iOS `sessionKeyName`): `the DeepSeek key
     * “DeepSeek 2”`. The session's own — the credential that failed, never a pick held for its next turn; null on a sign-in, OpenCode's
     * own configuration, or a key the account no longer lists. */
    val sessionKeyName get() = provider.takeIf { it.isNotEmpty() && it !in ProviderEngines.LOGIN_ENGINES && it != ProviderEngines.OPENCODE }
        ?.let { slug -> providers.firstOrNull { it.string("slug") == slug } }?.let(ProviderEngines::keyName)
    /** The CLI that runs this session is Antigravity: on its own sign-in, or on a key it runs. */
    val executesAntigravity get() = engine == ProviderEngines.ANTIGRAVITY
    val executesDsh get() = engine == DshRuntime.ENGINE

    /** A card has asked for the runner: what the minute's re-read keeps up to date. */
    private var asked = false

    /** Re-read the runner and the providers: on a card's first appearance, and back from the page that fixes it — each read tried
     * three times, as a page's opening reads are (A07-18). A read that fails keeps what is on screen. */
    fun refresh() { scope.launch { reload() } }
    suspend fun reload() { asked = true; read { threeTries(it) } }

    /** This session's runner row again (A07-18, iOS bc790273c `refreshRunner`), on every reconnect and once a minute while the
     * session streams: for the cards, once one has asked for it, and for the composer's catalogue. Read once; a read that fails keeps
     * what is on screen. */
    suspend fun refreshRunner() {
        if (asked) read { it() }
        composer.refreshCatalog()
    }

    private suspend fun read(attempts: suspend (suspend () -> JsonElement) -> JsonElement) {
        try {
            val id = runnerId
            runner = (attempts { management.get("runners") } as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { ObjectId.same(it.string("id"), id) }
            providers = (attempts { management.get("providers") } as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }

    // MARK: Antigravity (iOS d2737d665, b173e3a28)

    private val antigravity get() = runner?.get("antigravity") as? JsonObject
    /** The runner's one install relay is carrying an install. */
    val installInFlight get() = (runner?.get("install") as? JsonObject)?.string("status") in setOf("pending", "installing")
    val canInstallAntigravity get() = runner != null && !RunnerPage.isOffline(runner!!, System.currentTimeMillis()) &&
        (antigravity?.get("supported") as? JsonPrimitive)?.booleanOrNull == true && !installing && !installInFlight
    /** Google sign-in can run on this runner (the runner page's own rule, A13c); else why not, in the runner page's words. */
    val googleSignIn get() = runner?.let(RunnerPage::antigravityCanSignIn) == true
    val googleSignInHint get() = RunnerPage.antigravityLoginHint(antigravity?.string("googleLogin"))

    fun installAntigravity() { if (canInstallAntigravity) install("antigravity", "Antigravity CLI") }

    /** The pinned CLI of [engine] onto this session's runner, through its one install relay; the relay's state comes back. */
    private fun install(engine: String, name: String) {
        val id = runnerId ?: return
        installing = true; error = null
        scope.launch {
            try {
                val state = management.post("runners/$id/install", buildJsonObject { put("engine", engine) }) as? JsonObject
                runner = runner?.let { JsonObject(it + ("install" to (state ?: JsonObject(emptyMap())))) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { error = "Couldn't install $name — ${directoryError(e)}." }
            finally { installing = false }
        }
    }

    /** Where Connect Gemini goes, on the web: the account's own Gemini key on Antigravity, else a new one. */
    suspend fun connectGeminiUrl(): String {
        val origin = handle.account.server.trimEnd('/')
        val mine = runCatching { (management.get("providers/mine") as? JsonArray)?.filterIsInstance<JsonObject>() }.getOrNull().orEmpty()
        val key = mine.firstOrNull { it.string("presetSlug") == "gemini" && it.string("runtime") == "antigravity" }?.string("id")
        return if (key != null) "$origin/providers/$key" else "$origin/providers/new/gemini"
    }

    /** The account's Gemini key this session may move to now: one its engine runs, runnable here. */
    val geminiSwitch: ProviderOption? get() {
        val runner = runner ?: return null
        val catalog = ComposerCatalog(runner, providers)
        return catalog.credentials(engine, detail?.let(catalog::antigravityKeyAvailable) ?: false).firstOrNull { choice ->
            val row = providers.firstOrNull { it.string("slug") == choice.id }
            choice.id != provider && choice.unavailable == null && row?.string("presetSlug") == "gemini" && row.string("runtime") == "antigravity"
        }
    }

    /** Onto [choice], on the engine the session already runs (contract §3.5). */
    fun switchTo(choice: ProviderOption) = composer.config(buildJsonObject {
        put("provider", choice.id); put("engine", engine)
        put("model", choice.models.firstOrNull()?.get("value")?.jsonPrimitive?.contentOrNull ?: ""); put("effort", "")
    })

    /** The failed message again, now that what stopped it is fixed — on the provider picked in the composer, if any (A07-8). */
    fun retry() = composer.retryFailed()

    // MARK: DeepSeek Harness (iOS e789ce3dc)

    /** Harness can go onto this session's runner from here: online, a release that runs it, and no install already under way. */
    val canInstallDsh get() = runner?.let { runner -> !RunnerPage.isOffline(runner, System.currentTimeMillis()) &&
        (runner["capabilities"] as? JsonArray)?.any { (it as? JsonPrimitive)?.contentOrNull == DshRuntime.RUNNER_CAPABILITY } == true } == true &&
        !installing && !installInFlight
    /** The install relay is carrying Harness's install. */
    val dshInstallInFlight get() = installInFlight && (runner?.get("install") as? JsonObject)?.string("engine") == DshRuntime.ENGINE

    fun installDsh() { if (canInstallDsh) install(DshRuntime.ENGINE, "DeepSeek Harness") }

    /** Where Update the API key goes, on the web (`onEditDshKey`): the page of the DeepSeek key this session runs on, else
     * Infrastructure's API keys, where one is connected or turned back on — every DeepSeek key runs Harness, so no other key's page
     * stands in for the session's. These clients don't edit keys themselves. */
    suspend fun dshKeyUrl(): String {
        val origin = handle.account.server.trimEnd('/')
        val mine = runCatching { (management.get("providers/mine") as? JsonArray)?.filterIsInstance<JsonObject>() }.getOrNull().orEmpty()
        return mine.firstOrNull { it.string("slug") == provider }?.string("id")?.let { "$origin/providers/$it" } ?: "$origin/infrastructure#keys"
    }

    // MARK: Cursor CLI (the board's iOS 5 ⑧)

    /** The account a session on Cursor CLI's own sign-in spends: its own pick, else its workspace's, else Default — as dispatch resolves
     * an id this runner does not report. */
    private val cursorAccount: String get() {
        val accounts = (CursorRuntime.health(runner)?.get("accounts") as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
        val wanted = detail?.string("cursorAccount") ?: (detail?.get("workspace") as? JsonObject)?.string("cursorAccount")
        return wanted?.takeIf { id -> accounts.any { it.string("id") == id } } ?: EngineAccounts.DEFAULT
    }

    /** What a Cursor CLI session's quota card says of whose usage ran out (AutoRetryLogic.CursorQuota): a key by its name; an account of
     * the runner's by its name, its plan, when its included usage comes back, and another account with room. Null on any other engine. */
    val cursorQuota: AutoRetryLogic.CursorQuota? get() {
        if (engine != CursorRuntime.ENGINE) return null
        if (provider != CursorRuntime.ENGINE) return AutoRetryLogic.CursorQuota(providers.firstOrNull { it.string("slug") == provider }?.string("label") ?: provider)
        val runner = runner ?: return AutoRetryLogic.CursorQuota(RunnerPage.accountLabel(cursorAccount, emptyList()))
        val accounts = (CursorRuntime.health(runner)?.get("accounts") as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
        val usage = EngineAccounts.usage(CursorRuntime.ENGINE, runner)
        val account = cursorAccount
        val snapshot = accountSnapshotReported(usage, account)
        val now = System.currentTimeMillis()
        val elsewhere = accounts.firstOrNull { other ->
            val id = other.string("id") ?: return@firstOrNull false
            id != account && other.string("auth") == "yes" && !RunnerPage.isPaused(other.string("pausedUntil"), now) &&
                cursorUsageLimit(accountSnapshotReported(usage, id), now) == null
        }
        return AutoRetryLogic.CursorQuota(RunnerPage.accountLabel(account, accounts), snapshot?.string("planName"),
            (snapshot?.get("includedUsage") as? JsonObject)?.string("resetsAt"),
            elsewhere?.let { it.string("id")!! to RunnerPage.accountLabel(it.string("id")!!, accounts) })
    }

    /** A new session on Cursor CLI's [account], in this session's workspace: the draft is opened on it, as the quota card's press asks
     * — the conversation itself can't move there yet (D5). */
    fun startCursorSession(account: String) {
        val workspace = (detail?.get("workspace") as? JsonObject)?.string("id") ?: detail?.string("agentId") ?: return
        val target = DraftTarget(workspace)
        app.composer(handle, target.key, target).hold(buildJsonObject {
            put("engine", CursorRuntime.ENGINE); put("provider", CursorRuntime.ENGINE); put("account", account)
        })
        openDraft(workspace)
    }

    // MARK: auto-retry (iOS `AutoRetryCardView`'s reads and presses on `ConsoleModel`)

    /** The newest message of a person the window holds, set by the reader as the window moves. */
    var lastUser by mutableStateOf<io.orbitd.android.core.realtime.RunEvent?>(null)
    /** What the server would re-send, asked for when the window holds no words of the reader's (`GET …/retry-message`): a run's
     * message sits thousands of events behind the window. */
    var serverRetryText by mutableStateOf(""); private set
    var serverRetrySender by mutableStateOf<JsonObject?>(null); private set
    /** The server said there is nothing of anybody's to re-send (`nothingToResend`): the card continues instead. */
    var serverNothingToResend by mutableStateOf(false); private set
    /** A Retry already pressed, from the press until what it asked for is out: both cards draw theirs disabled meanwhile. */
    var retryInFlight by mutableStateOf(false); private set
    /** The answer a Retry got when another run had the task — shown where the press was. */
    var takenOver by mutableStateOf<io.orbitd.android.tasks.TaskRunHandoff.Conflict?>(null)
    var retryError by mutableStateOf<String?>(null); private set

    /** When the armed retry fires, or null when nothing is armed. */
    val retryAtMs get() = detail?.string("retryAt")?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
    /** Attempts spent on the current outage — what separates "never armed" from "gave up". */
    val retryAttempts get() = (detail?.get("retryAttempts") as? JsonPrimitive)?.intOrNull ?: 0
    /** Whether the window holds words of the reader's own to re-send: theirs, not another Orbit session's. */
    val retryWordsAreTheReaders get() = lastUser?.let { it.personWords().isNotBlank() && it.fields["sessionMessage"] !is JsonObject } == true
    /** What a Retry re-sends: the reader's words on screen, else the server's answer. */
    val retryText get() = if (retryWordsAreTheReaders) lastUser!!.personWords().trim() else serverRetryText
    /** The card's continue state: nothing of anybody's to re-send, and no words of the reader's here that their own send would carry. */
    val retryContinues get() = serverNothingToResend && !retryWordsAreTheReaders

    suspend fun reloadRetryState() { runCatching { reloadDetail() } }
    suspend fun loadRetryText() {
        if (retryWordsAreTheReaders || serverRetryText.isNotEmpty() || serverRetrySender != null) return
        val answer = runCatching { management.get("sessions/$sessionId/retry-message") as? JsonObject }.getOrNull() ?: return
        serverRetryText = answer.string("text").orEmpty()
        serverRetrySender = answer["sessionMessage"] as? JsonObject
        serverNothingToResend = (answer["nothingToResend"] as? JsonPrimitive)?.booleanOrNull == true
    }

    /** Turn the armed retry off, or put it back at [atMs]; the card then shows the server's answer, not the press. */
    fun setAutoRetry(atMs: Long?) {
        retryError = null
        scope.launch {
            try {
                if (atMs != null) management.post("sessions/$sessionId/auto-retry", buildJsonObject { put("retryAt", java.time.Instant.ofEpochMilli(atMs).toString()) })
                else management.delete("sessions/$sessionId/auto-retry")
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { retryError = "Couldn't change auto-retry — ${directoryError(e)}." }
            reloadRetryState()
        }
    }

    /** The card's press: the failed message again, through the retry door (the server re-sends it under a key of its own, so a second
     * press is the turn already queued), on the provider picked in the composer. With nothing of anybody's to re-send it is the
     * continue, sent as anything typed is (A07-12). Another run holding the task answers in the card. */
    fun retryLastMessage() {
        if (retryInFlight) return
        retryInFlight = true; retryError = null
        scope.launch {
            try {
                if (retryContinues && serverRetryText.isEmpty()) composer.sendMessage(AutoRetryLogic.continueMessage)
                else management.post("sessions/$sessionId/retry-message", composer.retryIdentity())
                takenOver = null
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) {
                takenOver = io.orbitd.android.tasks.TaskRunHandoff.readConflict(e)
                if (takenOver == null) retryError = directoryError(e)
            } finally { retryInFlight = false }
            reloadRetryState()
        }
    }
}

internal val LocalSessionConsole = staticCompositionLocalOf<SessionConsole?> { null }

/** A07-18 (iOS bc790273c: `runnerPollTask` and the reconnect's `refreshRunner`): [refresh] on every reconnect of the session's
 * stream — its first connect is the page opening, whose reads are its own — and once a minute for as long as it stays connected. */
internal suspend fun refreshWhileStreaming(connected: Flow<Boolean>, refresh: suspend () -> Unit, minute: Long = 60_000) {
    var connects = 0
    connected.distinctUntilChanged().collectLatest { up ->
        if (!up) return@collectLatest
        if (connects++ > 0) refresh()
        while (true) { delay(minute); refresh() }
    }
}

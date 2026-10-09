package io.orbitd.android.reader

import androidx.compose.runtime.*
import io.orbitd.android.OrbitApplication
import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.ProviderChoices
import io.orbitd.android.composer.ProviderOption
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/**
 * What a card in the conversation acts through (iOS's `ConsoleModel`, as the Antigravity repair card reads it): the session's
 * freshest detail, its runner and the account's providers as last read, its composer, and the runner's page it sends the reader
 * to. Absent in a render with no session behind it, where those cards fall back to the runtime's own sentence.
 */
@Stable
internal class SessionConsole(val app: OrbitApplication, val handle: SessionHandle, val sessionId: String, val composer: ComposerModel,
    private val scope: CoroutineScope, private val reloadDetail: suspend () -> Unit, val openRunner: (runner: String, engine: String) -> Unit,
    val openSession: (String) -> Unit) {
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
    /** The CLI that runs this session is Antigravity: its own provider, or a key that borrows it. */
    val executesAntigravity get() = ProviderChoices.executingRuntime(provider, providers) == "antigravity"

    /** Re-read the runner and the providers: on a card's first appearance, and back from the page that fixes it. */
    fun refresh() { scope.launch { reload() } }
    suspend fun reload() {
        try {
            val id = runnerId
            runner = (management.get("runners") as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { ObjectId.same(it.string("id"), id) }
            providers = (management.get("providers") as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
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

    fun installAntigravity() {
        val id = runnerId ?: return
        if (!canInstallAntigravity) return
        installing = true; error = null
        scope.launch {
            try {
                val state = management.post("runners/$id/install", buildJsonObject { put("engine", "antigravity") }) as? JsonObject
                runner = runner?.let { JsonObject(it + ("install" to (state ?: JsonObject(emptyMap())))) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { error = "Couldn't install Antigravity CLI — ${directoryError(e)}." }
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

    /** The account's Gemini key on Antigravity this session may move to now: same CLI, runnable here. */
    val geminiSwitch: ProviderOption? get() {
        val runner = runner ?: return null
        val catalog = ComposerCatalog(runner, providers)
        val choices = catalog.sameRuntime(provider, catalog.choices(detail?.let(catalog::antigravityKeyAvailable) ?: false))
        return choices.firstOrNull { choice ->
            val row = providers.firstOrNull { it.string("slug") == choice.id }
            choice.id != provider && choice.unavailable == null && row?.string("presetSlug") == "gemini" && row.string("runtime") == "antigravity"
        }
    }

    fun switchTo(choice: ProviderOption) = composer.config(buildJsonObject {
        put("provider", choice.id); put("model", choice.models.firstOrNull()?.get("value")?.jsonPrimitive?.contentOrNull ?: ""); put("effort", "")
    })

    /** The failed message again, now that what stopped it is fixed — on the provider picked in the composer, if any (A07-8). */
    fun retry() = composer.retryFailed()

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

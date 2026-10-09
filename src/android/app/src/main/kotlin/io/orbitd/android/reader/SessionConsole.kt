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
internal class SessionConsole(val app: OrbitApplication, val handle: SessionHandle, val composer: ComposerModel, private val scope: CoroutineScope,
    val openRunner: (runner: String, engine: String) -> Unit) {
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
    /** Google sign-in can run on this runner (googleLogin `available`); else why not, in the runner page's words. */
    val googleSignIn get() = antigravity?.string("googleLogin") == "available"
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

    /** The failed message again, now that what stopped it is fixed. */
    fun retry() = composer.control("retry-message", body = JsonObject(emptyMap()))
}

internal val LocalSessionConsole = staticCompositionLocalOf<SessionConsole?> { null }

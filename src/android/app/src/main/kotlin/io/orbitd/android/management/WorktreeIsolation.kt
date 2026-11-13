package io.orbitd.android.management

import androidx.compose.material3.Switch
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.reader.MainCheckout
import io.orbitd.android.reader.MainCheckoutModel
import io.orbitd.android.reader.MainCheckoutReviewSheet
import io.orbitd.android.reader.MainCheckoutState
import io.orbitd.android.reader.MainCheckoutTransport
import io.orbitd.android.reader.WorktreeIsolationDialog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun ManagementApi.mainCheckoutTransport() = object : MainCheckoutTransport {
    override suspend fun get(path: List<String>, query: List<Pair<String, String>>) = this@mainCheckoutTransport.get(path.joinToString("/"), query)
    override suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject?): JsonElement? = when (method) {
        HttpMethod.PATCH -> patch(path.joinToString("/"), body ?: JsonObject(emptyMap()))
        else -> post(path.joinToString("/"), body ?: JsonObject(emptyMap()))
    }
}

/**
 * A workspace's Worktree isolation switch on the runner page (web's runner-page workspace form), with board 04's dialogs: switching
 * stays immediate and never touches a file; it only says first what a dirty or stuck main checkout means for new sessions, or that
 * sessions keep their unmerged worktrees when it goes off. [reload] reads the runner page again once the switch has been saved.
 */
@Composable
internal fun WorktreeIsolationSwitch(api: ManagementApi, workspace: JsonObject, reload: suspend () -> Unit, failed: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val id = workspace.text("id")
    val on = workspace.bool("enableWorktree") == true
    val health = workspace["repoHealth"] as? JsonObject
    var saving by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<Pair<Boolean, MainCheckout.IsolationDialog>?>(null) }
    val review = remember(api, id) { MainCheckoutModel(api.mainCheckoutTransport(), null, api.background).also { it.bind(id) } }
    val reviewState by review.state.collectAsState()
    LaunchedEffect(workspace) { review.adoptWorkspace(workspace) }

    fun save(next: Boolean) {
        dialog = null
        saving = true
        scope.launch {
            try { api.patch("workspaces/$id", buildJsonObject { put("enableWorktree", next) }); reload() }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { failed(if (next) "Couldn't turn on worktree isolation" else "Couldn't turn off worktree isolation") }
            finally { saving = false }
        }
    }

    fun press(next: Boolean) {
        if (next) {
            MainCheckout.turnOnDialog(health)?.let { dialog = true to it } ?: save(true)
            return
        }
        saving = true
        scope.launch {
            // Sessions that keep an unmerged worktree: what turning off leaves as it is. Unknown counts as none, as web's form says nothing.
            val unmerged = try {
                (api.get("sessions", listOf("workspaceId" to id, "view" to "open")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                    .count(MainCheckout::holdsUnmergedWorktree)
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { 0 }
            saving = false
            val root = health?.text("root")?.takeIf { it.isNotEmpty() } ?: workspace.text("workDir")
            MainCheckout.turnOffDialog(root, unmerged)?.let { dialog = false to it } ?: save(false)
        }
    }

    Switch(on, { press(it) }, Modifier.testTag("worktree-isolation:$id").semantics { contentDescription = MainCheckout.ISO_LABEL }, enabled = !saving)
    dialog?.let { (next, d) ->
        WorktreeIsolationDialog(d,
            review = { dialog = null; review.open(MainCheckoutState.Sheet.REVIEW) },
            cleanUp = { dialog = null; review.cleanUp() },
            confirm = { save(next) }, cancel = { dialog = null })
    }
    if (reviewState.sheet == MainCheckoutState.Sheet.REVIEW) MainCheckoutReviewSheet(review, isolated = false, sessionBranch = null, sessionTitle = null) {
        review.open(null)
    }
}

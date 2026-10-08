package io.orbitd.android.cards

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.CoordinatorStartCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.*

/** A04 is the only live-state owner. Reconnection/foreground/REST invalidations all feed this rail. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCards(open: (String) -> Unit, discuss: ((String) -> Unit)? = null) {
    val resources = LocalReaderResources.current ?: return
    val app = LocalContext.current.applicationContext as OrbitApplication
    val auth by resources.auth.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    if ((auth as? AuthState.SignedIn)?.handle !== resources.handle || realtime.handle !== resources.handle) return
    val session = realtime.session?.takeIf { it.id == resources.sessionId && !it.accessDenied } ?: return
    val actions = remember(resources.handle) { CardActions(resources.auth, app.realtime, app.processScope) }
    val results by actions.state.collectAsState()
    val sessionCards = remember(session.snapshot) { session.snapshot?.let { CardCatalog.session(session.id, it) }.orEmpty() }
    var watches by remember(resources.handle, session.id) { mutableStateOf<List<InteractionCard>>(emptyList()) }
    val current = sessionCards + watches
    val project = session.snapshot?.detail?.text("projectId") ?: session.snapshot?.detail?.obj("project")?.text("id")
    var created by remember(resources.handle, session.id) { mutableStateOf<JsonObject?>(null) }
    var merged by remember(resources.handle, session.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var graph by remember(resources.handle, session.id) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(session.fresh, resources.handle, session.id, project, realtime.invalidationRevision) {
        if (!session.fresh) return@LaunchedEffect
        val api = CardAuthority(resources.auth, resources.handle)
        suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement? = try { api.get(path, query) }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        coroutineScope {
            val tasks = async { read(listOf("sessions", session.id, "created-tasks")) }
            val receipts = async { project?.let { read(listOf("projects", it, "promotions", "merged")) } }
            val plan = async { if (current.any { it.family == CardFamily.START }) project?.let { read(listOf("projects", it, "dependency-graph")) } else null }
            val following = listOf(listOf("state" to "ACTIVE"), listOf("state" to "PAUSED"), emptyList(), listOf("needsAttention" to "true")).map { query ->
                async { (read(listOf("watches"), query) as? JsonArray).orEmpty().filterIsInstance<JsonObject>() }
            }
            created = tasks.await() as? JsonObject
            merged = (receipts.await() as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            graph = plan.await() as? JsonObject
            watches = following.flatMap { it.await() }.distinctBy { it.text("id") }
                .filter { ObjectId.same(it.text("observerSessionId"), session.id) }
                .mapNotNull { AuxiliaryCards.watch(session.id, it) }
        }
    }
    // Keep only a bounded in-memory history of cards this viewport actually saw. Absence is not success.
    var previous by remember(resources.handle, session.id) { mutableStateOf<List<InteractionCard>>(emptyList()) }
    LaunchedEffect(current, session.fresh) {
        if (session.fresh) previous = (current + previous.filter { old -> current.none { it.key == old.key } }
            .map { it.copy(actions = emptyList(), status = "No longer pending · check the server record") }).take(80)
        try { actions.restore(resources.handle, current) } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { /* Auth/storage errors leave the host's freshness gate closed. */ }
    }
    val shown = if (session.fresh) current + previous.filter { old -> current.none { it.key == old.key } }
        .map { it.copy(actions = emptyList(), status = "No longer pending · check the server record") } else previous.ifEmpty { current }
    Column(Modifier.fillMaxWidth().testTag("interaction-cards"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (shown.isNotEmpty()) {
            Text("Decisions and requests", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { app.realtime.refreshSession() }) { Text("Check status") }
            if (!session.fresh) Text("Reconnecting · actions are unavailable until the server is checked.", style = MaterialTheme.typography.bodySmall)
        }
        val focus = CardFocus.pending(session.id)
        shown.distinctBy { it.key }.forEach { original -> key(resources.handle, original.key, original.binding) {
            val card = if (original.family == CardFamily.START && graph != null) original.copy(context = JsonObject(original.context + ("plan" to graph!!))) else original
            // A11 hook: the card a project page opened this conversation onto is brought into view once drawn.
            val requester = remember { BringIntoViewRequester() }
            if (focus != null && CardFocus.matches(focus, card.key)) LaunchedEffect(focus, card.key) {
                requester.bringIntoView(); CardFocus.spend(session.id)
            }
            Box(Modifier.bringIntoViewRequester(requester)) {
                val fresh = session.fresh && actions.valid(resources.handle, session.id) && (card.family != CardFamily.START || graph != null)
                val result = results[card.key]?.takeIf { it.binding == card.binding } ?: CardActionState()
                val submit = { verb: CardVerb, input: CardInput -> actions.submit(resources.handle, card, verb, input); Unit }
                // A11b hook: the coordinator's request draws the start card (iOS `StartProjectCardView`), not the generic card.
                if (card.family == CardFamily.START) CoordinatorStartCard(card, session.snapshot?.standing.orEmpty(), fresh, result, open, discuss, submit)
                else BusinessCard(card, fresh, result, open, discuss, submit)
            }
        } }
        merged.filter { it.text("state") == "MERGED" }.forEach { receipt ->
            Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Text("Merged", style = MaterialTheme.typography.titleSmall)
                    CardFields(receipt, listOf("sourceRef", "sourceSha", "upstreamRef", "tasks", "merged"), open)
                }
            }
        }
        created?.takeIf { (it.number("total") ?: 0) > 0 }?.let { tasks ->
            Text("Tasks created here", style = MaterialTheme.typography.titleSmall)
            if (tasks.number("total") == 1) Text(tasks.objects("items").firstOrNull()?.text("title") ?: createdTasksCountLine(tasks))
            else Text(createdTasksCountLine(tasks))
            // A11 hook: a created task's row opens its task page (iOS `CreatedTasksCard` row → task detail).
            DetailFold("tasks") { tasks.objects("items").forEach { task ->
                val taskId = task.text("id")
                // A column, as the fields were laid out in the card's own column before the row became pressable.
                Column(Modifier.fillMaxWidth().then(if (taskId == null) Modifier
                    else Modifier.clickable(role = Role.Button) { open("orbit-task:$taskId") }.testTag("created-task:$taskId")),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CardFields(task, listOf("title", "status", "running", "replaces"), open)
                }
            } }
        }
        session.snapshot?.background?.forEach { job ->
            DetailFold("Background work · ${job.text("description") ?: job.text("taskId") ?: job.text("id") ?: ""}") {
                CardFields(job, listOf("status", "command", "description", "latestOutput", "output", "outputTail", "exitCode", "killReason"), open)
            }
        }
    }
}

package io.orbitd.android.composer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.realtime.SessionState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import io.orbitd.android.management.CursorCopy
import io.orbitd.android.management.Ink
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.UsageRow
import io.orbitd.android.management.usageRows
import kotlinx.serialization.json.*

/**
 * The toolbar's usage gauge (board docs/mocks/android-composer-parity ②, iOS `ContextWindowIndicator` on a phone): the context
 * window's ring, no number beside it, and — where the account's plan reports a window ([planRow], its binding one) — that window's
 * bar beside the ring in a hairline capsule, kept at its own width. Pressed, the bottom sheet with both readings and the context
 * actions (decided 2026-11-19: a sheet, as iOS's).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ComposerUsage(model: ComposerModel, state: ComposerState, detail: JsonObject, session: SessionState?, planRow: UsageRow? = null) {
    var expanded by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    val running = detail.text("runState") == "RUNNING" || detail.text("status") == "RUNNING"
    val events = session?.transcript?.events.orEmpty()
    fun reported(key: String) = events.asReversed().firstNotNullOfOrNull { event ->
        (event.fields[key] as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    }
    val tokens = reported("contextTokens") ?: 0
    val window = reported("contextWindow") ?: state.catalog?.let { it.models(it.engineOf(detail), detail.text("provider").orEmpty()) }
        ?.firstOrNull { it.text("value") == detail.text("model") }?.get("contextWindow")?.jsonPrimitive?.longOrNull?.takeIf { it > 0 }
    // Cursor CLI never reports how much of its window a session has used (contract §4.1): no reading, rather than 0 (iOS 5 ⑦).
    val noContext = ProviderChoices.engine(detail, state.catalog?.providers.orEmpty()) == CursorRuntime.ENGINE
    val contextLabel = if (noContext) CursorRuntime.UNAVAILABLE else if (window == null) "$tokens tokens" else "$tokens / $window tokens"
    // A07-7: a session on a pool spends one of its accounts at a time, named in the sheet (iOS f929ab1e4) once the catalog is in.
    // The plan's reading beside the ring comes off the catalogue (its runner's report, a pool account's own), read as the composer
    // opens, as iOS reads its runner's plan usage with the console: the bar is there from the start, not after a menu was opened.
    LaunchedEffect(detail.text("provider")) { if (state.catalog == null && !state.catalogLoading) model.loadCatalog() }
    val account = state.catalog?.poolAccount(detail)
    val fraction = if (window != null && !noContext) (tokens.toFloat() / window).coerceIn(0f, 1f) else 0f
    val percent = if (tokens > 0) Math.round(fraction * 100) else 0
    // Aloud: the share used, or why there is none; then the plan's window, which the ring's capsule draws beside it.
    val spoken = when {
        noContext -> "Context: ${CursorRuntime.UNAVAILABLE}"
        tokens <= 0 -> "Context: no reading yet"
        window == null -> "Context: $tokens tokens"
        else -> "Context $percent% used"
    } + (planRow?.let { ", ${it.label} ${it.reading}" } ?: "")
    Box(Modifier.height(48.dp).widthIn(min = TOOLBAR_RING.dp).clip(RoundedCornerShape(12.dp))
        .clickable(role = Role.Button) { expanded = true; model.loadCatalog() }
        .semantics { contentDescription = spoken }.testTag("composer-context"), contentAlignment = Alignment.Center) {
        if (planRow == null) UsageRingIcon(percent, noContext)
        // No outline round the pair: iOS 26's hairline capsule (board composer-usage-tap 03 C) does not show on its glass card.
        else Row(Modifier.height(28.dp).padding(horizontal = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            UsageBarIcon(planRow); UsageRingIcon(percent, noContext)
        }
    }
    if (expanded) ModalBottomSheet(onDismissRequest = { expanded = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("composer-context-sheet")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, bottom = 24.dp)) {
            Text("Context and plan usage", Modifier.padding(bottom = 12.dp), style = MaterialTheme.typography.titleLarge)
            if (noContext) {
                Row(Modifier.fillMaxWidth().testTag("composer-context-unavailable")) {
                    Text(CursorRuntime.CONTEXT_WINDOW, Modifier.weight(1f)); Text(CursorRuntime.UNAVAILABLE, fontWeight = FontWeight.SemiBold)
                }
                Text(CursorRuntime.CONTEXT_UNAVAILABLE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else Text("Context: $contextLabel")
            if (window != null && !noContext) LinearProgressIndicator(progress = { (tokens.toFloat() / window).coerceIn(0f, 1f) })
            // Cursor CLI's model by the chip's words (iOS 5 ④), never its value with the parameters in brackets.
            if (noContext) Row(Modifier.fillMaxWidth()) {
                Text("Model", Modifier.weight(1f))
                Text(CursorRuntime.modelName(state.catalog, detail.text("provider") ?: CursorRuntime.ENGINE, detail.text("model").orEmpty(),
                    detail.text("effort")), color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else Text("${detail.text("provider").orEmpty()} · ${detail.text("model").orEmpty()}")
            // Whose quota this is (iOS a0a76a760): the pool's account, which the toolbar has no room for on a phone.
            account?.let {
                Row(Modifier.fillMaxWidth()) {
                    Text("Account", Modifier.weight(1f))
                    Text(it.label, Modifier.widthIn(max = 220.dp).testTag("composer-pool-account").semantics { contentDescription = it.help },
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry usage") } }
            val usage = state.catalog?.usage(detail)
            if (usage == null && !state.catalogLoading) Text("No quota reported for this account.")
            usage?.let { snapshot ->
                snapshot.text("planType")?.let { Text(it) }
                snapshot.text("fetchedAt")?.let { Text("Updated $it", style = MaterialTheme.typography.bodySmall) }
                // An Antigravity account's buckets say what is left, as agy does; a Kimi Code account's windows are its own
                // /usage panel's three, the month among them; a Cursor CLI account's its included usage, read only above 0%.
                val provider = snapshot.text("provider")
                if (provider == ProviderEngines.CURSOR) snapshot.text("planName")?.let { Text(CursorCopy.plan(it)) }
                if (provider == "antigravity" || provider == "kimi" || provider == ProviderEngines.CURSOR) usageRows(snapshot).forEach { row ->
                    row.groupLabel?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Text("${row.label}: ${row.reading}")
                    // A spent window's bar is full and red: at 0% remaining it would otherwise be an empty track.
                    LinearProgressIndicator(progress = { row.gaugeFraction }, Modifier.testTag("composer-usage-bar-${row.key}"),
                        color = if (row.spent) Ink.red else ProgressIndicatorDefaults.linearColor)
                    row.window.text("resetsAt")?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                }
                if (provider == ProviderEngines.CURSOR && usageRows(snapshot).isEmpty())
                    Text(CursorCopy.USAGE_UNAVAILABLE + " — " + CursorCopy.usageUnavailable(snapshot.text("planName")), style = MaterialTheme.typography.bodySmall)
                val limits = snapshot.objects("rateLimits")
                val blocks = if (provider == "kimi" || provider == ProviderEngines.CURSOR) emptyList() else if (limits.isEmpty()) listOf(snapshot) else limits
                blocks.forEach { block ->
                    block.text("limitName")?.let { Text(it) }
                    listOf("fiveHour" to "5 hours", "sevenDay" to "7 days", "sevenDayOpus" to "Opus · 7 days", "sevenDaySonnet" to "Sonnet · 7 days", "primary" to "Primary", "secondary" to "Secondary").forEach { (key, label) ->
                        (block[key] as? JsonObject)?.let { row ->
                            val percent = (row["utilization"] as? JsonPrimitive)?.doubleOrNull
                            if (percent != null) {
                                Text("${row.text("label") ?: label}: ${percent.toInt()}%")
                                LinearProgressIndicator(progress = { (percent.toFloat() / 100).coerceIn(0f, 1f) },
                                    color = if (percent >= 100) Ink.red else ProgressIndicatorDefaults.linearColor)
                                row.text("resetsAt")?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                    (block["credits"] as? JsonObject)?.let { credit ->
                        Text(if (credit.flag("unlimited") == true) "Credits: unlimited" else "Credits: ${credit.text("balance") ?: "unreported"}")
                    }
                }
            }
            // The runner's own Codex sign-in carries earned reset credits: the card under its windows (iOS CodexResetCreditCard), read
            // off the runner as the card last re-read it — and not drawn for an account with none (A07-9).
            val runner = state.catalog?.runner
            val reset = runner?.text("id")?.let { id -> remember(id) { CodexResetModel(ManagementApi(model.auth, model.handle), id).also { it.runner = runner } } }
            val resetBlock = CodexReset.block(detail, state.catalog?.copy(runner = reset?.runner ?: runner ?: JsonObject(emptyMap()))?.usage(detail))
            if (reset != null && resetBlock != null && CodexReset.visible(resetBlock)) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                CodexResetCreditCard(reset, resetBlock, CodexReset.accountOverride(detail, model.target != null, state.draft.resumeConfig.text("account")),
                    model.target?.workspaceId ?: detail.text("agentId") ?: (detail["workspace"] as? JsonObject)?.text("id"))
            }
            // Board 03: under the readings, a divider and the actions — Compact where the engine has `/compact` (greyed while a turn
            // runs), Start a new coordinator in a project's current coordinator. Neither, no divider. While a handoff has the composer
            // locked, no Compact at all: no turn of this conversation is to come (web's `compactOffered`, OrbitKit hides the gauge).
            val compact = model.target == null && CoordinatorHandoff.outgoing(detail)?.locksComposer != true && CoordinatorHandoff.compactOffered(state.catalog?.let { it.slashItems(it.engineOf(detail), detail.text("agentId")) }.orEmpty())
            val handOver = model.target == null && CoordinatorHandoff.startOffered(detail)
            if (compact || handOver) HorizontalDivider(Modifier.padding(vertical = 8.dp))
            if (compact) {
                val enabled = CoordinatorHandoff.compactEnabled(running, CoordinatorHandoff.outgoing(detail))
                ContextActionRow(R.drawable.ic_compact, CoordinatorHandoffCopy.COMPACT,
                    if (enabled) CoordinatorHandoffCopy.COMPACT_DETAIL else CoordinatorHandoffCopy.COMPACT_WHILE_RUNNING, enabled, "context-action-compact") {
                    expanded = false; model.compact()
                }
            }
            if (handOver) ContextActionRow(R.drawable.ic_handoff, CoordinatorHandoffCopy.START_NEW_COORDINATOR,
                if (running) CoordinatorHandoffCopy.START_NEW_COORDINATOR_WHILE_RUNNING else CoordinatorHandoffCopy.START_NEW_COORDINATOR_DETAIL,
                true, "context-action-new-coordinator") {
                expanded = false; confirming = true
            }
        }
    }
    // Board 03 ③: the sheet closes and the confirm takes its place; the waits that move are read for it, as a count.
    val projectId = CoordinatorHandoff.projectId(detail)
    if (confirming && projectId != null) {
        val api = remember(model) { CoordinatorHandoffApi(model.auth, model.handle) }
        var waits by remember { mutableStateOf<List<HandoffWait>?>(null) }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        LaunchedEffect(projectId) { waits = runCatching { api.pendingWaits(projectId) }.getOrNull() }
        HandoverConfirm(running, waits, busy, error, model, state, detail, onHandOver = { successor ->
            busy = true; error = null
            scope.launch {
                try { api.post(projectId, successor = successor); confirming = false }
                catch (cancel: CancellationException) { throw cancel }
                catch (e: Exception) { error = CoordinatorHandoff.refusal(e) }
                finally { busy = false }
            }
        }, onCancel = { confirming = false })
    }
}

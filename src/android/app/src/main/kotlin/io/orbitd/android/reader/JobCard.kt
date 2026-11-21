package io.orbitd.android.reader

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.R
import io.orbitd.android.cards.Disclosure
import io.orbitd.android.core.cards.BgJob
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * What a bg_run job's card reads about its job, joined by job id (web `BgJobHostCtx`, `JobShellsCtx`, `JobWakesCtx`, `JobQueuedWakesCtx`),
 * built by the reader. [shells]: the session's bg_run jobs as GET /sessions/:id/background lists them, which alone says whether one can be
 * stopped. [wakes]: the wake turns loaded, oldest first. [queued]: each wake still on the queue, with its `Don't send` (null where it cannot
 * be taken off the queue). [live]: whether the session's run is not over. [where]: the workspace it runs on, named on an opened card.
 * [tail] and [stop]: the two routes, absent where no session is behind the page (a guest's).
 */
@Immutable
internal data class JobCards(
    val shells: Map<String, JsonObject> = emptyMap(),
    val wakes: Map<String, List<BgJob.WakeSeen>> = emptyMap(),
    val queued: Map<String, (() -> Unit)?> = emptyMap(),
    val live: Boolean = false,
    val where: String? = null,
    val tail: (suspend (String) -> JsonObject)? = null,
    val stop: (suspend (String) -> Unit)? = null,
) {
    companion object {
        /** The session's bg_run jobs from its Background list, by job id. */
        fun shells(background: List<JsonObject>): Map<String, JsonObject> =
            background.filter { it.text("kind") == "job" }.mapNotNull { row -> row.text("shellId")?.let { it to row } }.toMap()

        /** The wake turns among [events], by job id; one whose delivery failed or went unconfirmed was never read. */
        fun wakes(events: List<RunEvent>, deliveries: Map<String, String> = emptyMap()): Map<String, List<BgJob.WakeSeen>> =
            BgJob.wakesOf(events.filter { it.type == "user" }.map { event ->
                val delivery = event.turnId?.let(deliveries::get) ?: event.fields.string("delivery")
                BgJob.Turn(event.fields.string("controlPlaneNote"), event.ts, delivery != "failed" && delivery != "unconfirmed")
            })
    }
}

internal val LocalJobCards = staticCompositionLocalOf { JobCards() }

/** The terminal tone the board draws a job's rail and icon in (web `.chat-tone-exec` `--tone`). */
internal val ExecTone = Color(0xFF0D9488)

/** The kind chip's accent tint, text on fill (web `.chat-tool-tag` in `.chat-tone-exec`: `--tone` on `--tone-bg`, light and dark). */
@Composable
private fun execTag(): Pair<Color, Color> =
    if (MaterialTheme.colorScheme.surface.luminance() < 0.5f) Color(0xFF2DD4BF) to Color(0x2E0D9488) else ExecTone to Color(0xFFE2F6F3)

/** Whether the app is in front: its lifecycle at least started. */
@Composable
private fun rememberStarted(): Boolean {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var started by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> started = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return started
}

/**
 * The job's newest lines, read while its card is on screen — composed in the transcript's list, which composes only what it shows — the app
 * is in front and the job runs (R2), at the route's pace: at once, then 5 s after each answer, one request at a time; 30 s after any other
 * failure; never again after a 404/409 (a runner too old to read it, or output that is gone), which shows no line and no error. Once the
 * job ends it is read once more, for its final lines (web `useJobTail`).
 */
@Composable
internal fun rememberJobTail(jobId: String?, running: Boolean, read: (suspend (String) -> JsonObject)?): JsonObject? {
    var tail by remember(jobId) { mutableStateOf<JsonObject?>(null) }
    var gone by remember(jobId) { mutableStateOf(false) }
    val lastStatus = remember(jobId) { mutableStateOf<String?>(null) }
    val active = jobId != null && read != null && running && !gone && rememberStarted()
    LaunchedEffect(active, jobId) {
        if (!active) return@LaunchedEffect
        while (true) {
            var wait = BgJob.TAIL_PACE_MS
            try {
                val answer = read!!(jobId!!)
                lastStatus.value = answer.text("status")
                tail = answer
                if (answer.text("status") != "running") return@LaunchedEffect
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: ApiError) {
                if (e.status == 404 || e.status == 409) { gone = true; return@LaunchedEffect }
                wait = BgJob.TAIL_RETRY_MS
            } catch (_: Exception) { wait = BgJob.TAIL_RETRY_MS }
            delay(wait)
        }
    }
    // The job's end arrived from elsewhere (its report, its wake): one more read for the lines it ended on.
    var wasRunning by remember(jobId) { mutableStateOf(running) }
    LaunchedEffect(running) {
        val ended = wasRunning && !running
        wasRunning = running
        if (!ended || gone || jobId == null || read == null || lastStatus.value != "running") return@LaunchedEffect
        lastStatus.value = null
        try { tail = read(jobId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }
    return tail
}

/** Now, in milliseconds, every second while [ticking]. */
@Composable
private fun rememberNow(ticking: Boolean): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ticking) {
        now = System.currentTimeMillis()
        while (ticking) { delay(1000); now = System.currentTimeMillis() }
    }
    return now
}

/** The R4 breakpoint (web `PHONE_QUERY`, max-width 600px): up to it, the kind chip and the run time move to a second, grey line. */
internal const val PHONE_WIDTH_DP = 600

/**
 * A `bg_run` job as one card from start to end (the owner's job-card board, choices A1 B1 C1 D1 E1 F1, rulings R1-R4 of 2026-11-21; web
 * `JobCard.tsx`, word for word). It stands where the call was: the terminal icon, the job's description, its kind and how long it has
 * run; folded, a spinner and the newest output line while it runs, then how it ended and its last lines. Opened: the command, where it
 * ran, the last 40 lines and every time it woke the agent. The turns those wakes opened draw nothing: the card says it. A running job
 * its runner can stop takes Stop, behind a confirmation, in the opened card and on the folded card's long press (R3).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun JobCardView(event: RunEvent, receipt: BgJob.Receipt?, highlighted: Boolean = false) {
    val jobs = LocalJobCards.current
    val input = event.fields["input"] as? JsonObject
    val jobId = receipt?.jobId
    val shell = jobId?.let { jobs.shells[it] }
    val wakes = jobId?.let { jobs.wakes[it] }.orEmpty()
    val queued = jobId != null && jobs.queued.containsKey(jobId)
    val dontSend = jobId?.let { jobs.queued[it] }
    var open by rememberSaveable(event.seq) { mutableStateOf(false) }
    var allLines by rememberSaveable(event.seq, "all") { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    val command = input?.text("command").orEmpty()
    val kind = BgJob.kind(input)
    val title = BgJob.title(input)

    // A first guess without the tail read, so the read itself knows whether the job runs.
    val known = BgJob.state(shell, wakes, null, jobs.live)
    val tail = rememberJobTail(jobId, known.phase == BgJob.Phase.RUNNING, jobs.tail)
    val state = if (tail != null) BgJob.state(shell, wakes, tail, jobs.live) else known
    val phase = state.phase
    val running = phase == BgJob.Phase.RUNNING
    val ended = phase == BgJob.Phase.DONE || phase == BgJob.Phase.FAILED || phase == BgJob.Phase.KILLED
    val output = BgJob.output(phase, shell, wakes, tail)

    val now = rememberNow(running)
    val start = BgJob.millis(receipt?.startedAt) ?: BgJob.millis(shell?.text("startedTs"))
    val end = if (running) now else BgJob.millis(state.endedAt)
    val elapsed = if (start != null && end != null) BgJob.elapsed(end - start) else null

    val stoppable = BgJob.stoppable(phase, shell) && jobId != null && jobs.stop != null
    val killedBy = if (phase == BgJob.Phase.KILLED) BgJob.killedBy(state.reason) else null
    val folded = BgJob.lastLines(output, if (running) 1 else 2)
    val lines = BgJob.lines(output)
    val shown = if (allLines) lines else lines.takeLast(BgJob.OPEN_LINES)
    val phone = LocalConfiguration.current.screenWidthDp <= PHONE_WIDTH_DP

    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    val red = MaterialTheme.colorScheme.error
    val mono = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    // The kind in the accent tint, so it never reads as another timer beside the grey run time (web `.chat-tool-tag`).
    val (tagText, tagFill) = execTag()
    val kindChip = @Composable {
        Text(kind, Modifier.background(tagFill, RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 1.dp).testTag("job-kind"),
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = tagText, maxLines = 1)
    }
    val elapsedChip = @Composable {
        elapsed?.let { Text(it, Modifier.background(grey.copy(alpha = 0.10f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp)
            .testTag("job-elapsed"), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = grey, maxLines = 1) }
    }

    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)
        .padding(horizontal = 10.dp, vertical = 6.dp).testTag("job-card:${jobId ?: event.seq}")) {
        Column(Modifier.fillMaxWidth()
            .background(ExecTone.copy(alpha = if (open) 0.06f else 0.03f), RoundedCornerShape(8.dp))
            .drawBehind { drawRect(ExecTone, size = size.copy(width = 3.dp.toPx())) }
            .padding(start = 11.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Box {
                Row(Modifier.fillMaxWidth().testTag("job-row")
                    .combinedClickable(onClickLabel = if (open) "Hide output" else "Show output", role = Role.Button,
                        onLongClick = if (stoppable && !open) ({ menu = true }) else null) { open = !open }
                    .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(if (open) R.drawable.ic_chevron_down else R.drawable.ic_chevron_forward), null, Modifier.size(12.dp),
                        tint = MaterialTheme.colorScheme.outline)
                    Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(16.dp).testTag("job-icon"), tint = ExecTone)
                    Text(title, Modifier.weight(1f).testTag("job-title"), style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!phone) { kindChip(); elapsedChip() }
                    state.quietMs?.takeIf { running }?.let { EndChip(BgJob.quiet(it), LocalOrbitColors.current.needsYou, "job-quiet") }
                    state.exitCode?.takeIf { phase == BgJob.Phase.FAILED }?.let { EndChip(BgJob.exit(it), red, "job-exit") }
                    if (phase == BgJob.Phase.KILLED) EndChip(BgJob.killed, grey, "job-killed")
                    JobMark(phase)
                }
                // The folded card's long press: Stop (R3), behind the same confirmation as the opened card's.
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(BgJob.stop) }, modifier = Modifier.testTag("job-menu-stop"),
                        onClick = { menu = false; confirming = true })
                }
            }
            // At phone width the kind and the run time leave the first line for a second, grey one (R4).
            if (phone) Row(Modifier.padding(start = 40.dp).testTag("job-sub"), horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically) { kindChip(); elapsedChip() }
            if (!open) {
                when {
                    running && folded.isNotEmpty() -> Text(folded.first(), Modifier.padding(start = 40.dp).testTag("job-live-line"), style = mono,
                        color = grey, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    phase == BgJob.Phase.KILLED -> killedBy?.let { KilledLine(it, Modifier.padding(start = 40.dp)) }
                    ended && folded.isNotEmpty() -> Column(Modifier.padding(start = 40.dp).testTag("job-ending"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        // Each of its last two lines on a line of its own, cut at the card's edge (web `.chat-job-tail`, white-space: pre).
                        Column(Modifier.testTag("job-tail")) {
                            folded.forEach { line -> Text(line, style = mono, color = if (phase == BgJob.Phase.FAILED) red else grey, maxLines = 1,
                                overflow = TextOverflow.Ellipsis) }
                        }
                        Text(BgJob.showFullOutput, Modifier.clickable(role = Role.Button) { open = true }.testTag("job-show-full"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            if (open) Column(Modifier.padding(start = 18.dp).testTag("job-detail"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (command.isNotEmpty()) SelectionContainer { Text("$ $command", Modifier.testTag("job-command"), style = mono) }
                Text(BgJob.meta(jobId, kind, start, if (ended) elapsed else null, jobs.where), Modifier.testTag("job-meta"),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = grey)
                killedBy?.let { KilledLine(it) }
                if (shown.isNotEmpty()) Column(Modifier.fillMaxWidth().background(grey.copy(alpha = 0.06f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 9.dp, vertical = 6.dp).testTag("job-output"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    // The normal text colour whatever the end: only the folded card's last lines turn red (web `.chat-job-output`).
                    SelectionContainer { Text(shown.joinToString("\n"), Modifier.testTag("job-output-text"),
                        style = mono.copy(fontSize = MaterialTheme.typography.labelSmall.fontSize), color = MaterialTheme.colorScheme.onSurface) }
                    if (shown.size < lines.size) Text(BgJob.showAll(lines.size), Modifier.clickable(role = Role.Button) { allLines = true }
                        .testTag("job-show-all"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
                if (stoppable) TextButton(onClick = { confirming = true }, Modifier.testTag("job-stop")) {
                    Text(BgJob.stop, style = MaterialTheme.typography.labelMedium, color = red)
                }
                if (wakes.isNotEmpty()) JobWakes(wakes)
            }
            // Its wake still on the queue: the agent has not read it, and the reader can keep it back (E1).
            if (queued) SubagentWakeQueued(Modifier.padding(start = 40.dp), dontSend)
        }
    }
    if (confirming && jobId != null) StopJobDialog(jobId, onDone = { confirming = false })
}

/** The Stop confirmation (R3) in the app's confirm style; it stays up while the stop is on its way, and closes once it is accepted. */
@Composable
internal fun StopJobDialog(jobId: String, onDone: () -> Unit) {
    val stop = LocalJobCards.current.stop ?: return
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!pending) onDone() }, modifier = Modifier.testTag("job-stop-dialog"),
        title = { Text(BgJob.stopTitle) },
        confirmButton = { TextButton(enabled = !pending, modifier = Modifier.testTag("job-stop-confirm"), onClick = {
            pending = true
            scope.launch {
                try { stop(jobId); onDone() }
                catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { }
                finally { pending = false }
            }
        }) { Text(BgJob.stop, color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(enabled = !pending, modifier = Modifier.testTag("job-stop-cancel"), onClick = onDone) { Text(BgJob.cancel) } })
}

@Composable
private fun EndChip(text: String, color: Color, tag: String) {
    Text(text, Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp).testTag(tag),
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = color, maxLines = 1)
}

@Composable
private fun KilledLine(text: String, modifier: Modifier = Modifier) =
    Text(text, modifier.testTag("job-killed-by"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** The row's mark: a spinner while it runs, then how it ended — ✓, red ✕, or a grey ■ for a job somebody stopped. */
@Composable
private fun JobMark(phase: BgJob.Phase) {
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    when (phase) {
        BgJob.Phase.RUNNING -> CircularProgressIndicator(Modifier.size(14.dp).testTag("job-mark:running"), color = grey, strokeWidth = 2.dp)
        BgJob.Phase.DONE -> Icon(painterResource(R.drawable.ic_check_circle), "done", Modifier.size(16.dp).testTag("job-mark:done"),
            tint = LocalOrbitColors.current.success)
        BgJob.Phase.FAILED -> Icon(painterResource(R.drawable.ic_x_circle), "failed", Modifier.size(16.dp).testTag("job-mark:failed"),
            tint = MaterialTheme.colorScheme.error)
        BgJob.Phase.KILLED -> Box(Modifier.size(16.dp).background(grey, CircleShape).semantics { contentDescription = "killed" }
            .testTag("job-mark:killed"), contentAlignment = Alignment.Center) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.surface, RoundedCornerShape(1.dp)))
        }
        BgJob.Phase.UNKNOWN -> Icon(painterResource(R.drawable.ic_remove_circle), null, Modifier.size(16.dp).testTag("job-mark:unknown"), tint = grey)
    }
}

/** Each time the job woke its agent: when, what it said, when the agent read it, and what it read. */
@Composable
private fun JobWakes(wakes: List<BgJob.WakeSeen>) {
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag("job-wakes")
        .background(grey.copy(alpha = 0.06f), RoundedCornerShape(topEnd = 6.dp, bottomEnd = 6.dp))) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(grey.copy(alpha = 0.5f)))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(BgJob.woke(wakes.size), Modifier.testTag("job-wakes-head"), style = MaterialTheme.typography.bodySmall, color = grey)
            wakes.forEachIndexed { i, wake ->
                var raw by rememberSaveable(wake.ts, i) { mutableStateOf(false) }
                Text(BgJob.wakeRow(wake), Modifier.testTag("job-wake:$i"), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface)
                Disclosure(BgJob.whatTheAgentRead, raw, "job-wake-raw:$i") { raw = !raw }
                if (raw) SelectionContainer {
                    Text(wake.text, Modifier.testTag("job-wake-raw-text:$i"),
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = grey)
                }
            }
        }
    }
}

/** Each bg_run call the window holds, by the job its receipt names: where a job's row in the Background list scrolls to (R1). */
internal fun jobCallsById(events: List<RunEvent>): Map<String, Long> {
    val calls = events.filter { it.type == "tool_use" && (it.fields.string("name") ?: it.fields.string("toolName")) == BgJob.TOOL }
        .mapNotNull { e -> e.toolId()?.let { it to e.seq } }.toMap()
    if (calls.isEmpty()) return emptyMap()
    return events.filter { it.type == "tool_result" }.mapNotNull { result ->
        val seq = result.toolId()?.let(calls::get) ?: return@mapNotNull null
        BgJob.receipt(contentText(result.fields["content"]) ?: result.fields.string("result"))?.let { it.jobId to seq }
    }.toMap()
}

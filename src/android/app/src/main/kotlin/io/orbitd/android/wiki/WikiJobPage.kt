package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.coroutines.delay

// A server run's page and its row on the Wiki page's Runs band (design §2.2, mock 35 ④⑤, P9) — the web's
// `WikiRunsCard.tsx`, which unfolds the same log inside its card: what kind of run, where it stands, how far it got and
// where it waits, then each model call — how long it waited and ran, what it spent and how it failed. A server run has
// no task and no session, so this page is its detail, and nothing on it links to one. Every word is `WikiRunsCopy`'s;
// `WikiServerExecutionFixtureTest` holds them to the shared fixture the other two ends read.

/** A model state's colour: up green; down amber — it comes back by itself; the rest red (`wikiModelTone`). */
@Composable
private fun modelColour(model: WikiSystemModelStatus): Color = when (WikiRunsLogic.modelTone(model.state)) {
    WikiRunsLogic.ModelTone.UP -> LocalOrbitColors.current.success
    WikiRunsLogic.ModelTone.WARN -> WikiPalette.amber
    WikiRunsLogic.ModelTone.ERROR -> MaterialTheme.colorScheme.error
}

/** The System model as the Runs band's head, the settings page and Set up say it: its state word in its colour. */
@Composable
internal fun WikiModelStateText(model: WikiSystemModelStatus) {
    Text("● " + WikiRunsCopy.modelState(model.state), Modifier.testTag("wiki-model-state"), style = WikiType.label, color = modelColour(model))
}

/** The System model as the settings page names it, read-only: its name over its state in its colour. */
@Composable
internal fun WikiModelValue(model: WikiSystemModelStatus) {
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(WikiRunsCopy.systemModelLabel(model.model), style = WikiType.prose, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        WikiModelStateText(model)
    }
}

/** A run's mark: green done, amber waiting, red failed, a spinner while it runs, grey cancelled. */
@Composable
private fun WikiRunMark(mark: WikiRunRow.Mark) {
    when (mark) {
        WikiRunRow.Mark.SPIN -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
        WikiRunRow.Mark.OK -> Box(Modifier.size(8.dp).background(LocalOrbitColors.current.success, CircleShape))
        WikiRunRow.Mark.WARN -> Box(Modifier.size(8.dp).background(WikiPalette.amber, CircleShape))
        WikiRunRow.Mark.ERROR -> Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.error, CircleShape))
        WikiRunRow.Mark.NONE -> Box(Modifier.size(8.dp).background(WikiPalette.secondary.copy(alpha = 0.45f), CircleShape))
    }
}

/** A run's state and the sentence after it, the state in semibold and its tone — amber while it waits, red when it
 * broke — as the web's row bolds it. */
@Composable
private fun runStateLine(row: WikiRunRow): AnnotatedString = buildAnnotatedString {
    val tone = when (row.tone) {
        WikiRunRow.Tone.WARN -> WikiPalette.amber
        WikiRunRow.Tone.ERROR -> MaterialTheme.colorScheme.error
        WikiRunRow.Tone.PLAIN -> MaterialTheme.colorScheme.onSurface
        WikiRunRow.Tone.MUTED -> WikiPalette.secondary
    }
    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = tone)) { append(row.state) }
    if (row.text.isNotEmpty()) append(" · " + row.text)
}

/** One run on the Runs band (mock 35 ④): its kind and when on the first line, its state and the sentence after it
 * under them — the whole row one press into the run's page. */
@Composable
internal fun WikiRunRowView(row: WikiRunRow, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 48.dp)
        .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-job-row"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(12.dp).padding(top = 4.dp), contentAlignment = Alignment.Center) { WikiRunMark(row.mark) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(row.kind, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(row.whenText, style = WikiType.label, color = WikiPalette.secondary)
            }
            Text(runStateLine(row), style = WikiType.subtext, color = WikiPalette.secondary)
        }
    }
}

/** One call of a run's log: the step and unit with its state on the first line, how long it waited and ran and its
 * tokens under them, and the error of a call that failed or waits again (mock 35 ⑤, the phone's two lines). */
@Composable
internal fun WikiCallRowView(row: WikiCallRow) {
    val colour = when (row.tone) {
        WikiCallRow.Tone.OK -> LocalOrbitColors.current.success
        WikiCallRow.Tone.WARN -> WikiPalette.amber
        WikiCallRow.Tone.ERROR -> MaterialTheme.colorScheme.error
        WikiCallRow.Tone.RUN -> MaterialTheme.colorScheme.primary
        WikiCallRow.Tone.MUTED -> WikiPalette.secondary
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-call-row"),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(row.call, Modifier.weight(1f), style = WikiType.mono, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(row.state, style = WikiType.label, color = colour)
        }
        val detail = listOfNotNull(row.retries, row.line.takeIf { it.isNotEmpty() }).joinToString(" · ")
        if (detail.isNotEmpty()) Text(detail, style = WikiType.label, color = WikiPalette.secondary)
        row.error?.let { Text(it, style = WikiType.label, color = MaterialTheme.colorScheme.error) }
    }
}

/** A run's page: where it stands, the line under its log, then its calls (mock 35 ⑤, iOS's run page). */
@Composable
internal fun WikiJobPage(job: WikiJob, now: Instant) {
    val row = WikiRunsLogic.row(job, now)
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-job-page"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "head") {
            WikiCard(Modifier.padding(top = 8.dp)) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(runStateLine(row), Modifier.testTag("wiki-job-state"), style = WikiType.prose, color = WikiPalette.secondary)
                    Text(row.whenText, style = WikiType.label, color = WikiPalette.secondary)
                }
                HorizontalDivider(Modifier.padding(start = 16.dp))
                Text(WikiRunsLogic.foot(job), Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("wiki-job-foot"),
                    style = WikiType.label, color = WikiPalette.secondary)
            }
        }
        if (job.requests.isNotEmpty()) {
            item(key = "calls-head") { WikiPlanSectionHead(WikiRunsCopy.callsTitle, WikiArticleCopy.count(job.calls.total)) }
            item(key = "calls") {
                WikiCard {
                    job.requests.forEachIndexed { i, call ->
                        if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                        WikiCallRowView(WikiRunsLogic.callRow(call, now))
                    }
                }
            }
        }
    }
}

/** One of the space's server runs, read again every few seconds while it is on its way (iOS `WikiJobView`). */
@Composable
internal fun WikiJobScreen(store: WikiStore, route: OrbitRoute) {
    val jobId = requireNotNull(route.id)
    val state by store.state.collectAsState()
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(jobId) { store.loadJobs() }
    // A run on its way counts up as the web's card does: a few seconds while it moves, a minute once it has ended.
    LaunchedEffect(jobId, state.jobsUnderWay) {
        while (true) {
            delay(if (state.jobsUnderWay) 5_000 else 60_000)
            now = Instant.now()
            if (store.state.value.jobsUnderWay) store.loadJobs()
        }
    }
    val job = state.job(jobId)
    PageBar.Bind(route, title = job?.let { WikiRunsCopy.kind(it.kind) } ?: WikiRunsCopy.runs, subtitle = job?.let { WikiRunsLogic.row(it, now).whenText })
    Box(Modifier.fillMaxSize().testTag("wiki-job")) {
        if (job != null) WikiJobPage(job, now)
        else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
    }
}

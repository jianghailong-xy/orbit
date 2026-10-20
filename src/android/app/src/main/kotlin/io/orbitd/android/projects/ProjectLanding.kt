package io.orbitd.android.projects

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.launch

// The landing's own marks (iOS ProjectLandingRow.swift, ProjectLandingCard.swift): the head every landing row wears — the merge
// check card's, the landing card's, the jobs list's — and the card a task landing on the project branch is drawn as. What they say
// is decided in ProjectPage (`landingLine`, `landingHead`, `landingCard`); this is only the drawing.

/** The head a card wears over a job in flight (iOS `ProjectLandingHead`, owner decision 2026-10-11, board
 * docs/mocks/project-merge-check-row): the timeline's "Merged into main" row one moment earlier — the 30 dp circle carrying the mark,
 * the word, the live clock at the right of it, and one line under both with the state, the wait and the freshness. No chevron: the
 * whole row is the press wherever there is one. */
@Composable
internal fun ProjectLandingHead(title: String, head: LandingHead, running: Boolean, timedOut: Boolean, modifier: Modifier = Modifier,
    detailLines: Int = 1) {
    val warning = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // The landing row's ink: the accent while the job runs, grey while it waits its turn or the app cannot read the server, and the
    // warning ink a runner the server stopped hearing from wears.
    val ink = if (timedOut) warning else if (running) MaterialTheme.colorScheme.primary else muted
    Row(modifier.fillMaxWidth().testTag("landing-head"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Box(Modifier.size(30.dp).background(ink.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
            if (timedOut) Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(16.dp).testTag("landing-head:timed-out"), tint = warning)
            else LandingRing(running, 15.dp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, Modifier.weight(1f).testTag("landing-head:title"), fontWeight = FontWeight.SemiBold, maxLines = 1,
                    overflow = TextOverflow.Ellipsis, color = if (timedOut) warning else Color.Unspecified)
                // The live number, the one thing on the row that moves: tabular digits so it does not jitter as it counts.
                Text(head.right, Modifier.testTag("landing-head:right"), style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                    fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1, softWrap = false)
            }
            Text(head.detail, Modifier.testTag("landing-head:detail"), style = MaterialTheme.typography.bodyMedium, color = muted,
                maxLines = detailLines, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The ring (iOS `LandingRing`): the project page's mark for work in hand, turning while the job runs and standing still while it waits
 * its turn. The system's animator scale stops the turn and nothing else — the state word beside it is what says which half this is. */
@Composable
internal fun LandingRing(running: Boolean, size: Dp) {
    val turn = if (running) rememberInfiniteTransition(label = "landing-ring")
        .animateFloat(0f, 360f, infiniteRepeatable(tween(1_600, easing = LinearEasing)), label = "landing-ring").value else 0f
    Icon(painterResource(R.drawable.ic_sync), null, Modifier.size(size).rotate(turn).testTag(if (running) "landing-ring:running" else "landing-ring:still"),
        tint = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * The landing in flight as a card of its own (iOS `ProjectLandingCardView`, owner decision 2026-10-11, docs/mocks/project-landing-card),
 * in the merge card's shape and colours: grey while a job is in flight, amber once the server judged its runner silent, and one press —
 * Retry — only where the server offers it. Its head is the landing row's; its body says what is landing — the task's title, or a row
 * per job with each one's own state — the branch it lands on, and the sentence that takes the reader off the hook, or, timed out,
 * where the runner stopped. A press opens the jobs in flight ([onOpenJobs]) or, from a server that lists none, [onOpenProject]; with
 * neither the card is a read. [retry] answers why a Retry did not go through, null when it did.
 */
@Composable
internal fun ProjectLandingCardView(card: LandingCard, onOpenJobs: (() -> Unit)?, onOpenProject: (() -> Unit)?, retry: suspend (String) -> String?,
    modifier: Modifier = Modifier) {
    val warning = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val scope = rememberCoroutineScope()
    var retrying by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    val shape = RoundedCornerShape(14.dp)
    val chrome = if (card.timedOut) Modifier.background(warning.copy(alpha = 0.08f), shape).border(1.dp, warning.copy(alpha = 0.3f), shape)
        else Modifier.background(muted.copy(alpha = 0.1f), shape)
    val press = onOpenJobs ?: onOpenProject
    Column(modifier.fillMaxWidth().then(chrome).padding(12.dp).testTag("landing-card"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth().then(if (press != null) Modifier.clickable(role = Role.Button, onClick = press) else Modifier)
            .testTag("landing-card:body"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ProjectLandingHead(card.title, card.head, card.running, card.timedOut)
            if (card.jobs.size > 1) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // Each job in its own ink, so a queued job behind a running one does not wear the running one's colour.
                card.jobs.forEach { job -> Row(Modifier.testTag("landing-card:job:${job.jobId}"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(job.title.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(job.state, style = MaterialTheme.typography.labelMedium, maxLines = 1,
                        color = if (job.timedOut) warning else if (job.running) MaterialTheme.colorScheme.primary else muted)
                } }
            } else card.what?.let {
                Text(it, Modifier.testTag("landing-card:what"), style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            // The branch it lands on, the field the task page's Target row prints, cut in the middle when the page is narrow.
            card.target?.let { Text("${ProjectPage.landingOnto} $it", Modifier.testTag("landing-card:onto"), style = MaterialTheme.typography.labelMedium,
                color = muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis) }
            if (card.timedOut) card.detail?.let { Text(it, Modifier.testTag("landing-card:detail"), style = MaterialTheme.typography.labelMedium, color = muted) }
            else Text(ProjectPage.landingNothingToDo, style = MaterialTheme.typography.labelMedium, color = muted)
        }
        card.retryJobId?.let { jobId ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = {
                    if (!retrying) {
                        retrying = true; actionError = null
                        scope.launch { try { actionError = retry(jobId) } finally { retrying = false } }
                    }
                }, enabled = !retrying, modifier = Modifier.heightIn(min = 40.dp).testTag("landing-card:retry")) { Text(ProjectPage.landingRetry) }
                Spacer(Modifier.weight(1f))
                // Only where there is a list to open: elsewhere the card's press goes to the project page, and "All jobs" would name nothing.
                onOpenJobs?.let { TextButton(onClick = it, modifier = Modifier.testTag("landing-card:all-jobs")) {
                    Text("${ProjectPage.landingAllJobs} ›", fontWeight = FontWeight.SemiBold) } }
            }
        }
        actionError?.let { Text(it, Modifier.testTag("landing-card:error"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis) }
    }
}

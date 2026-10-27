package io.orbitd.android.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.cards.PromotionReview
import io.orbitd.android.cards.SheetHead
import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.LandingEntryLink
import io.orbitd.android.projects.LandingLine
import io.orbitd.android.projects.ProjectLandingHead
import io.orbitd.android.reader.AbandonButton
import io.orbitd.android.reader.LandingSessionCopy
import io.orbitd.android.reader.landingEntry
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The merge into main as the project's sessions page draws it, under the progress card (iOS `ProjectMergeCardView`, mocks in
 * docs/mocks/project-merge-sessions-page): one card at four moments — the merge check running, the candidate asking, merging, or
 * blocked. Its presses are the review's, both the page's [merge] model's, and Details opens that review for the whole of it. Only the
 * asking card is orange with a badge: it is the one thing on the page waiting on the reader. A press that did not go through says why
 * under the card.
 */
@Composable
internal fun ProjectMergeCardView(merge: ProjectMergeModel, shape: ProjectMergeCard.Shape, landing: LandingLine?, blockedBy: String?, now: Instant,
    onLanding: (() -> Unit)?, roundLanding: String?, mergeJob: JsonObject?, mergeJobDetail: String?, jobCount: Int,
    openLanding: (String) -> Unit, abandon: suspend (String) -> String?, rerunCheck: suspend (String) -> String?,
    onDetails: (String) -> Unit, onCoordinator: (() -> Unit)?) {
    val view = merge.current
    // A merge job the server judged timed out turns the WHOLE card amber, as the landing card does (owner 2026-10-19),
    // whichever moment it is in.
    val timedOut = landing?.timedOut == true
    val tint = when {
        timedOut -> LocalOrbitColors.current.needsYou
        shape == ProjectMergeCard.Shape.CHECKING -> MaterialTheme.colorScheme.onSurfaceVariant
        shape == ProjectMergeCard.Shape.ASKING || shape == ProjectMergeCard.Shape.BLOCKED -> LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.primary
    }
    val scope = rememberCoroutineScope()
    var acting by remember { mutableStateOf(false) }
    var actionError by remember(view?.text("promotionId")) { mutableStateOf<String?>(null) }
    fun act(press: suspend (JsonObject) -> String?) {
        val candidate = view ?: return
        if (acting) return
        acting = true; actionError = null
        scope.launch { try { actionError = press(candidate) } finally { acting = false } }
    }
    /** One of the timed-out card's doors: no second press while it is out, and a refusal said under the card in the server's words. */
    fun run(label: String, press: suspend () -> String?) {
        if (acting) return
        acting = true; actionError = null
        scope.launch { try { actionError = press()?.let { "$label — ${it.trimEnd('.')}." } } finally { acting = false } }
    }
    // A merge job the server judged timed out: the checking card's own line and doors (board v4 04 c5/c6).
    val timedOutDoors: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            // A check can be run again (J-T9, revision 16) on the candidate it was run for; a merge that stopped at the push has no
            // retry, only the end (J-T10).
            val promotionId = view?.text("promotionId")
            if (mergeJob?.text("kind") == "CHECK_PROMOTION" && promotionId != null) Button(onClick = { run(LandingSessionCopy.RERUN_FAILED) { rerunCheck(promotionId) } },
                enabled = !acting, modifier = Modifier.heightIn(min = 40.dp).testTag("project-merge-card:rerun")) { Text(LandingSessionCopy.RERUN_THE_CHECK) }
            Spacer(Modifier.weight(1f))
            mergeJob?.text("jobId")?.let { jobId ->
                AbandonButton({ run(LandingSessionCopy.ABANDON_FAILED) { abandon(jobId) } }, !acting,
                    Modifier.heightIn(min = 40.dp).testTag("project-merge-card:abandon"))
            }
        }
    }
    /** The other jobs the round stands for, kept out of sight by the card: their way in here — "+N job queued · All jobs ›". */
    val queuedFoot: @Composable () -> Unit = {
        if (jobCount > 1 && onLanding != null) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LandingSessionCopy.moreJobsQueued(jobCount)?.let { Text(it, Modifier.testTag("project-merge-card:more-jobs"),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onLanding, modifier = Modifier.testTag("project-merge-card:all-jobs")) {
                Text("${LandingSessionCopy.ALL_JOBS} ›", fontWeight = FontWeight.SemiBold) }
        }
    }
    val shapeModifier = when {
        timedOut -> Modifier.background(tint.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
            .border(1.dp, tint.copy(alpha = 0.3f), RoundedCornerShape(14.dp))
        shape == ProjectMergeCard.Shape.CHECKING -> Modifier.background(tint.copy(alpha = 0.1f), RoundedCornerShape(14.dp))
        else -> Modifier.background(tint.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
            .border(1.dp, tint.copy(alpha = 0.3f), RoundedCornerShape(14.dp))
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).then(shapeModifier).padding(12.dp)
        .testTag("project-merge-card:${shape.name.lowercase()}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (shape) {
            ProjectMergeCard.Shape.CHECKING -> {
                landing?.let { LandingHeadRow(it, onLanding, roundLanding, openLanding, PromotionCards.cancelRequested(view)) }
                if (timedOut) {
                    mergeJobDetail?.let { Text(it, Modifier.testTag("project-merge-card:detail"), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    timedOutDoors()
                } else {
                    // What a pass leads to, drawn as the merging card's note: the Automatic setting merges it, or it becomes the card that asks.
                    PromotionCards.onPassLine(view)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    queuedFoot()
                }
            }
            ProjectMergeCard.Shape.ASKING -> view?.let { Asking(it, merge.criteriaMet, tint, now, acting, ::act, merge, onDetails) }
            // A timed-out merge has no Cancel: the attempt is already over as far as the server is concerned, and its doors are the
            // two the checking card draws (J-T9's re-check, J-T10's end).
            ProjectMergeCard.Shape.MERGING -> view?.let { Merging(it, tint, landing, onLanding, roundLanding, openLanding, timedOut, mergeJobDetail,
                acting, queuedFoot, timedOutDoors) { act(merge::cancel) } }
            ProjectMergeCard.Shape.BLOCKED -> view?.let {
                Blocked(it, PromotionCards.holder(it.text("promotionId").orEmpty(), merge.openItems), blockedBy, tint, now, onDetails, onCoordinator)
            }
        }
        actionError?.let { Text(it, Modifier.testTag("project-merge-card:error"), color = MaterialTheme.colorScheme.error, maxLines = 3,
            overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium) }
    }
}

/** The merge job's live row — the merged line's own anatomy, so the check and the merge it becomes are one shape (iOS 3b23aa163,
 * board docs/mocks/project-merge-check-row). Since 2026-10-19 (方案 A) the whole row opens THIS ROUND's landing session; a server
 * that names none keeps main's press, the jobs list. A stop asked for and not yet answered is the head's own clause (§3.3 M-T10). */
@Composable
private fun LandingHeadRow(line: LandingLine, onLanding: (() -> Unit)?, roundLanding: String?, openLanding: (String) -> Unit,
    stopRequested: Boolean) {
    val press: (() -> Unit)? = if (roundLanding != null) ({ openLanding(roundLanding) }) else onLanding
    val head = if (stopRequested) line.head.copy(detail = "${line.head.detail} · ${PromotionCards.stopRequestedClause}") else line.head
    Box(Modifier.fillMaxWidth().testTag("project-merge-card:landing").then(if (press != null) Modifier.clickable(role = Role.Button, onClick = press) else Modifier)) {
        ProjectLandingHead(line.word, head, line.running, line.timedOut)
    }
}

/** The CONFIRMED card's foot names the round's landing beside Cancel (方案 A); a server that names none says so in grey. */
@Composable
private fun OpenLandingFoot(roundLanding: String?, openLanding: (String) -> Unit) =
    LandingEntryLink(landingEntry(roundLanding), "project-merge-card:open-landing", openLanding)

/** The card's head: the moment's mark in the tint's tile, its title, and the badge while it asks. The merging card wears the same
 * merge mark as the asking one rather than a spinner (owner decision 2026-10-07, iOS 39adc7561): its one moving mark is the landing
 * row's ring. */
@Composable
private fun Head(title: String, icon: Int, tint: Color, titleInk: Color, badge: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(26.dp).background(tint.copy(alpha = 0.15f), RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, Modifier.size(16.dp).testTag("project-merge-card:mark:${if (icon == R.drawable.ic_merge) "merge" else "warning"}"), tint = tint)
        }
        Text(title, Modifier.weight(1f).semantics { heading() }.testTag("project-merge-card:title"), color = titleInk,
            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        badge?.let {
            Text(it, Modifier.background(tint, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp), color = Color.White,
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

/** A: what would land, the proof it was checked, and the two presses — the full review is Details away. */
@Composable
private fun Asking(view: JsonObject, criteriaMet: Pair<Int, Int>?, tint: Color, now: Instant, acting: Boolean,
    act: (suspend (JsonObject) -> String?) -> Unit, merge: ProjectMergeModel, onDetails: (String) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Head(PromotionCards.pageTitle(view), R.drawable.ic_merge, tint, MaterialTheme.colorScheme.onSurface, PromotionCards.needsYouBadge)
    Text(PromotionCards.branchLine(view), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
    HorizontalDivider(color = tint.copy(alpha = 0.25f))
    Text(PromotionCards.pageCounts(view), Modifier.testTag("project-merge-card:counts"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    val (titles, more) = PromotionCards.taskTitles(view)
    titles.forEach { title ->
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("•", color = muted, style = MaterialTheme.typography.labelLarge)
            Text(title, Modifier.testTag("project-merge-card:task"), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    PromotionCards.moreTasks(more)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted) }
    Text("${PromotionCards.previewChecks(view)} · ${PromotionCards.upstreamLine(view)}", Modifier.testTag("project-merge-card:checks"),
        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
        color = if (PromotionCards.checksClean(view)) LocalOrbitColors.current.success else MaterialTheme.colorScheme.onSurface)
    criteriaMet?.let { (met, total) -> PromotionCards.criteriaLine(met, total) }?.let {
        Text(it, Modifier.testTag("project-merge-card:criteria"), style = MaterialTheme.typography.labelMedium, color = muted)
    }
    Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { act(merge::confirm) }, enabled = !acting && PromotionCards.confirmable(view),
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("project-merge-card:confirm")) { Text(PromotionCards.mergeTo(PromotionCards.mainBranch(view))) }
        OutlinedButton(onClick = { act(merge::decline) }, enabled = !acting,
            modifier = Modifier.heightIn(min = 48.dp).testTag("project-merge-card:decline")) { Text(PromotionCards.notNow) }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(PromotionCards.askedLine(view, now).orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = muted)
        DetailsPress(view, onDetails)
    }
}

/** B: under way, and the reader may walk away; Cancel until the push begins, and the round's landing at the card's foot (方案 A). A
 * round the server judged timed out has no Cancel left: its two doors are the checking card's. Once the owner asked it to stop
 * (§3.3 M-T10, the server's `cancelRequested`) the card says it is cancelling — or, past the push boundary, that the ask came too
 * late — Cancel is the dead `Cancel requested`, and the queue's foot is not drawn. */
@Composable
private fun Merging(view: JsonObject, tint: Color, landing: LandingLine?, onLanding: (() -> Unit)?, roundLanding: String?,
    openLanding: (String) -> Unit, timedOut: Boolean, detail: String?, acting: Boolean,
    queuedFoot: @Composable () -> Unit, timedOutDoors: @Composable () -> Unit, cancel: () -> Unit) {
    val cancelling = PromotionCards.cancelRequested(view)
    Head(PromotionCards.mergingCardTitle(view), R.drawable.ic_merge, tint, tint)
    Text(PromotionCards.mergingCardStatus(view), Modifier.testTag("project-merge-card:status"), style = MaterialTheme.typography.labelLarge)
    landing?.let { LandingHeadRow(it, onLanding, roundLanding, openLanding, cancelling) }
    if (timedOut) {
        detail?.let { Text(it, Modifier.testTag("project-merge-card:detail"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant) }
        timedOutDoors()
    } else {
        Text(PromotionCards.mergingCardNote(view), Modifier.testTag("project-merge-card:note"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!cancelling) queuedFoot()
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OpenLandingFoot(roundLanding, openLanding)
            Spacer(Modifier.weight(1f))
            // The board's and the web's dead press in Cancel's own place (board v4 04 11:41), not a second Cancel to press.
            if (cancelling) OutlinedButton(onClick = {}, enabled = false,
                modifier = Modifier.heightIn(min = 48.dp).testTag("project-merge-card:cancel-requested")) { Text(PromotionCards.cancelRequestedLabel) }
            else OutlinedButton(onClick = cancel, enabled = !acting && PromotionCards.cancellable(view),
                modifier = Modifier.heightIn(min = 48.dp).testTag("project-merge-card:cancel")) { Text(PromotionCards.cancel) }
        }
    }
}

/** D: why it cannot merge, who is in front of it when the project's own line is busy (iOS befc9694c), and who has it — the
 * coordinator, until the clock hands it over; nobody, once the project's items were read and none holds it, draws no press (main's
 * 8297b18a3). Details opens every row of it. */
@Composable
private fun Blocked(view: JsonObject, holder: PromotionHolder, blockedBy: String?, tint: Color, now: Instant, onDetails: (String) -> Unit,
    onCoordinator: (() -> Unit)?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Head(PromotionCards.pageTitle(view), R.drawable.ic_warning, tint, tint)
    Text(PromotionCards.blockedLine(view), Modifier.testTag("project-merge-card:why"), style = MaterialTheme.typography.labelLarge)
    // The landing holding this branch, and what is holding that one; absent while the line is doing nothing here.
    blockedBy?.let { line ->
        Text(buildAnnotatedString { withStyle(SpanStyle(color = muted)) { append("${ProjectMergeCard.blockedByLabel}: ") }; append(line) },
            Modifier.fillMaxWidth().testTag("project-merge-card:blocked-by"), style = MaterialTheme.typography.labelMedium)
    }
    PromotionCards.resolvingLine(holder, now)?.let { line ->
        val yours = PromotionCards.resolvingIsYours(holder)
        Row(Modifier.fillMaxWidth().background(muted.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(vertical = 7.dp)
            .testTag("project-merge-card:resolving"), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            if (PromotionCards.resolvingSpins(holder)) { CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted); Spacer(Modifier.width(6.dp)) }
            Text(line, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (yours) LocalOrbitColors.current.needsYou else muted)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        DetailsPress(view, onDetails)
        Spacer(Modifier.weight(1f))
        onCoordinator?.let {
            TextButton(onClick = it, modifier = Modifier.testTag("project-merge-card:coordinator")) {
                Text("${PromotionCards.openCoordinator} ›", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun DetailsPress(view: JsonObject, onDetails: (String) -> Unit) {
    TextButton(onClick = { onDetails(view.text("promotionId").orEmpty()) }, modifier = Modifier.testTag("project-merge-card:details")) {
        Text("${PromotionCards.details} ›", fontWeight = FontWeight.SemiBold)
    }
}

/** The merge review over the sessions page (iOS `PromotionReviewSheet` with the page's model as its source): read afresh as it opens,
 * and pressed at the page's model, so the card under it moves with it. Decline closes it once it went through. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectMergeReviewSheet(merge: ProjectMergeModel, promotionId: String, blockedBy: String?, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var acting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(promotionId) { merge.load(force = true) }
    val view = merge.standing(promotionId)
    fun act(closeOnSuccess: Boolean = false, press: suspend (JsonObject) -> String?) {
        val candidate = view ?: return
        if (acting) return
        acting = true; error = null
        scope.launch {
            try { press(candidate).let { refused -> error = refused; if (refused == null && closeOnSuccess) close() } } finally { acting = false }
        }
    }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("project-merge-review")) {
        Column(Modifier.fillMaxWidth().fillMaxHeight()) {
            SheetHead(PromotionCards.previewTitle(view), "project-merge-review", close)
            HorizontalDivider()
            PromotionReview(view, merge.criteriaMet, PromotionCards.holder(promotionId, merge.openItems), acting, error, "project-merge-review",
                confirm = { act(press = merge::confirm) }, decline = { act(closeOnSuccess = true, press = merge::decline) }, cancel = { act(press = merge::cancel) },
                blockedBy = blockedBy)
        }
    }
}

package io.orbitd.android.directory

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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.cards.PromotionHints
import io.orbitd.android.cards.PromotionReview
import io.orbitd.android.cards.SheetHead
import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.LandingLine
import io.orbitd.android.projects.LandingRow
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.WikiDate
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
internal fun ProjectMergeCardView(merge: ProjectMergeModel, shape: ProjectMergeCard.Shape, landing: LandingLine?, now: Instant,
    onLanding: (() -> Unit)?, onDetails: (String) -> Unit, onCoordinator: (() -> Unit)?) {
    val view = merge.current
    val tint = when (shape) {
        ProjectMergeCard.Shape.CHECKING -> MaterialTheme.colorScheme.onSurfaceVariant
        ProjectMergeCard.Shape.ASKING, ProjectMergeCard.Shape.BLOCKED -> LocalOrbitColors.current.needsYou
        ProjectMergeCard.Shape.MERGING -> MaterialTheme.colorScheme.primary
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
    val shapeModifier = if (shape == ProjectMergeCard.Shape.CHECKING) Modifier.background(tint.copy(alpha = 0.1f), RoundedCornerShape(14.dp))
        else Modifier.background(tint.copy(alpha = 0.08f), RoundedCornerShape(14.dp)).border(1.dp, tint.copy(alpha = 0.3f), RoundedCornerShape(14.dp))
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).then(shapeModifier).padding(12.dp)
        .testTag("project-merge-card:${shape.name.lowercase()}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (shape) {
            ProjectMergeCard.Shape.CHECKING -> landing?.let { LandingRow(it, onLanding) }
            ProjectMergeCard.Shape.ASKING -> view?.let { Asking(it, merge.criteriaMet, tint, now, acting, ::act, merge, onDetails) }
            ProjectMergeCard.Shape.MERGING -> view?.let { Merging(it, tint, landing, onLanding, acting) { act(merge::cancel) } }
            ProjectMergeCard.Shape.BLOCKED -> view?.let { Blocked(it, PromotionCards.holder(it.text("promotionId").orEmpty(), merge.openItems), tint, now, onDetails, onCoordinator) }
        }
        actionError?.let { Text(it, Modifier.testTag("project-merge-card:error"), color = MaterialTheme.colorScheme.error, maxLines = 3,
            overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium) }
    }
}

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

/** B: under way, and the reader may walk away; Cancel until the push begins. */
@Composable
private fun Merging(view: JsonObject, tint: Color, landing: LandingLine?, onLanding: (() -> Unit)?, acting: Boolean, cancel: () -> Unit) {
    Head(PromotionCards.pageTitle(view), R.drawable.ic_merge, tint, tint)
    Text(PromotionCards.mergingStatusLine(view), Modifier.testTag("project-merge-card:status"), style = MaterialTheme.typography.labelLarge)
    landing?.let { LandingRow(it, onLanding) }
    Text(PromotionCards.pageNothingToDo, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        OutlinedButton(onClick = cancel, enabled = !acting && PromotionCards.cancellable(view),
            modifier = Modifier.heightIn(min = 48.dp).testTag("project-merge-card:cancel")) { Text(PromotionCards.cancel) }
    }
}

/** D: why it cannot merge, and who has it — the coordinator, until the clock hands it over; nobody, once the project's items were read
 * and none holds it, draws no press (main's 8297b18a3). Details opens every row of it. */
@Composable
private fun Blocked(view: JsonObject, holder: PromotionHolder, tint: Color, now: Instant, onDetails: (String) -> Unit, onCoordinator: (() -> Unit)?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Head(PromotionCards.pageTitle(view), R.drawable.ic_warning, tint, tint)
    Text(PromotionCards.blockedLine(view), Modifier.testTag("project-merge-card:why"), style = MaterialTheme.typography.labelLarge)
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

/** A merge already made, as a row on the project's timeline (iOS `ProjectMergeTimelineRow`): what went onto main and who merged it, at
 * the instant it happened. Shaped unlike a session row because it is not one, and a tap opens its receipt. */
@Composable
internal fun ProjectMergeTimelineRow(receipt: PromotionReceipt, now: Instant, onOpen: () -> Unit) {
    val view = receipt.promotion
    val success = LocalOrbitColors.current.success
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = PromotionHints.receipt, onClick = onOpen)
        .padding(horizontal = 16.dp, vertical = 10.dp).testTag("project-merge-row:${view.text("promotionId").orEmpty()}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Box(Modifier.size(30.dp).background(success.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_merge), null, Modifier.size(16.dp), tint = success)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(PromotionCards.timelineTitle(view), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                WikiDate.relative(view.obj("merged")?.text("at"), now)?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false)
                }
            }
            Text(PromotionCards.timelineDetail(view), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The merge review over the sessions page (iOS `PromotionReviewSheet` with the page's model as its source): read afresh as it opens,
 * and pressed at the page's model, so the card under it moves with it. Decline closes it once it went through. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectMergeReviewSheet(merge: ProjectMergeModel, promotionId: String, close: () -> Unit) {
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
                confirm = { act(press = merge::confirm) }, decline = { act(closeOnSuccess = true, press = merge::decline) }, cancel = { act(press = merge::cancel) })
        }
    }
}

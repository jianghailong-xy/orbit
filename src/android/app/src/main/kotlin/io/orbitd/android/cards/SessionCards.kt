package io.orbitd.android.cards

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.CoordinatorDoneCard
import io.orbitd.android.projects.CoordinatorStartCard
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*

/**
 * What a conversation's cards hold between the rail in its transcript and the review that opens over it (A08-2; iOS ConsoleView's
 * `approvalReview` and `ApprovalReviewDrafts`): the doors' one [CardActions], the reads the cards need beside the session's own, the
 * cards this window saw, and which card's review is open. The reader remembers it outside the transcript's recyclable rows, so a
 * review open over a card the list has scrolled away keeps its card, its answers and its press.
 */
@Stable
class SessionCardsModel internal constructor(val handle: SessionHandle, val sessionId: String, val actions: CardActions,
    private val reviewKey: MutableState<String?>) {
    var watches by mutableStateOf<List<InteractionCard>>(emptyList()); internal set
    var created by mutableStateOf<JsonObject?>(null); internal set
    var merged by mutableStateOf<List<JsonObject>>(emptyList()); internal set
    var graph by mutableStateOf<JsonObject?>(null); internal set
    var previous by mutableStateOf<List<InteractionCard>>(emptyList()); internal set
    /** The card whose review is open, by its address — kept across the Activity being recreated. */
    val review: String? get() = reviewKey.value
    /** What this window pressed in the open review: the press its receipt answers to. */
    var pressed by mutableStateOf<CardVerb?>(null); internal set
    fun open(key: String) { pressed = null; reviewKey.value = key }
    fun close() { reviewKey.value = null; pressed = null }

    /** The server's cards now, and the watches this conversation observes. */
    fun current(session: SessionState): List<InteractionCard> = session.snapshot?.let { CardCatalog.session(session.id, it) }.orEmpty() + watches
    /** What the rail draws: the current cards, then the ones it saw that the server stopped publishing, kept to say so. Absence is
     * not success. While reconnecting it is what it last saw. */
    fun shown(session: SessionState, current: List<InteractionCard> = current(session)): List<InteractionCard> =
        (if (session.fresh) current + previous.filter { old -> current.none { it.key == old.key } }.map(::stale) else previous.ifEmpty { current })
            .distinctBy { it.key }.map(::withPlan)
    /** The start card reads the project's task graph beside its request (A11b). */
    fun withPlan(card: InteractionCard) =
        if (card.family == CardFamily.START && graph != null) card.copy(context = JsonObject(card.context + ("plan" to graph!!))) else card
    fun fresh(session: SessionState, card: InteractionCard) =
        session.fresh && actions.valid(handle, session.id) && (card.family != CardFamily.START || graph != null)

    internal companion object {
        fun stale(card: InteractionCard) = card.copy(actions = emptyList(), status = CardPreviews.stale)
    }
}

@Composable
fun rememberSessionCards(app: OrbitApplication, handle: SessionHandle, sessionId: String): SessionCardsModel {
    val review = rememberSaveable(sessionId) { mutableStateOf<String?>(null) }
    return remember(handle, sessionId) { SessionCardsModel(handle, sessionId, CardActions(app.session, app.realtime, app.processScope), review) }
}

/** The signed-in session the cards belong to, or null while another account, another session or no access is showing. */
@Composable
private fun cardSession(): Pair<OrbitApplication, SessionState>? {
    val resources = LocalReaderResources.current ?: return null
    val app = LocalContext.current.applicationContext as OrbitApplication
    val auth by resources.auth.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    if ((auth as? AuthState.SignedIn)?.handle !== resources.handle || realtime.handle !== resources.handle) return null
    val session = realtime.session?.takeIf { it.id == resources.sessionId && !it.accessDenied } ?: return null
    return app to session
}

/** The cards' own reads and bookkeeping, run by the reader whether or not the rail is on screen: what this conversation created,
 * the merges it recorded, the project's task graph for a start card, the watches it observes; the confirmation re-read when its
 * review is due; the stale copies; and the doors' fences restored. A04 is the only live-state owner; these re-read on its
 * invalidations. */
@Composable
fun SessionCardsReads(cards: SessionCardsModel) {
    val (app, session) = cardSession() ?: return
    val realtime by app.realtime.state.collectAsState()
    val sessionCards = remember(session.snapshot) { session.snapshot?.let { CardCatalog.session(session.id, it) }.orEmpty() }
    val current = sessionCards + cards.watches
    val project = session.snapshot?.detail?.text("projectId") ?: session.snapshot?.detail?.obj("project")?.text("id")
    val wantsPlan = current.any { it.family == CardFamily.START }
    LaunchedEffect(session.fresh, cards.handle, session.id, project, realtime.invalidationRevision, wantsPlan) {
        if (!session.fresh) return@LaunchedEffect
        val api = CardAuthority(app.session, cards.handle)
        suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement? = try { api.get(path, query) }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        coroutineScope {
            val tasks = async { read(listOf("sessions", session.id, "created-tasks")) }
            val receipts = async { project?.let { read(listOf("projects", it, "promotions", "merged")) } }
            val plan = async { if (wantsPlan) project?.let { read(listOf("projects", it, "dependency-graph")) } else null }
            val following = listOf(listOf("state" to "ACTIVE"), listOf("state" to "PAUSED"), emptyList(), listOf("needsAttention" to "true")).map { query ->
                async { (read(listOf("watches"), query) as? JsonArray).orEmpty().filterIsInstance<JsonObject>() }
            }
            cards.created = tasks.await() as? JsonObject
            cards.merged = (receipts.await() as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            cards.graph = plan.await() as? JsonObject
            cards.watches = following.flatMap { it.await() }.distinctBy { it.text("id") }
                .filter { ObjectId.same(it.text("observerSessionId"), session.id) }
                .mapNotNull { AuxiliaryCards.watch(session.id, it) }
        }
    }
    // A08-1: a report still with its reviewer is read again a second after its review is due (iOS `scheduleReviewDueRead`), so
    // "Reviewing since" turns into what came of it without waiting for the next event.
    val reviewDue = sessionCards.firstNotNullOfOrNull { card ->
        card.source.obj("waiting")?.obj("review")?.takeIf { card.family == CardFamily.OWNER_CONFIRMATION && it.text("state") == "UNDER_REVIEW" }?.text("dueAt")
    }
    LaunchedEffect(reviewDue) {
        val due = reviewDue?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() } ?: return@LaunchedEffect
        delay((java.time.Duration.between(java.time.Instant.now(), due).toMillis() + 1_000).coerceAtLeast(0))
        app.realtime.refreshSession()
    }
    // Keep only a bounded in-memory history of cards this viewport actually saw. Absence is not success.
    LaunchedEffect(current, session.fresh) {
        if (session.fresh) cards.previous = (current + cards.previous.filter { old -> current.none { it.key == old.key } }
            .map(SessionCardsModel::stale)).take(80)
        try { cards.actions.restore(cards.handle, current) } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { /* Auth/storage errors leave the host's freshness gate closed. */ }
    }
}

/** A04 is the only live-state owner. Reconnection/foreground/REST invalidations all feed this rail. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCards(cards: SessionCardsModel, open: (String) -> Unit, discuss: ((String) -> Unit)? = null) {
    val (app, session) = cardSession() ?: return
    val results by cards.actions.state.collectAsState()
    val shown = cards.shown(session)
    Column(Modifier.fillMaxWidth().testTag("interaction-cards"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (shown.isNotEmpty()) {
            Text("Decisions and requests", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { app.realtime.refreshSession() }) { Text("Check status") }
            if (!session.fresh) Text("Reconnecting · actions are unavailable until the server is checked.", style = MaterialTheme.typography.bodySmall)
        }
        val focus = CardFocus.pending(session.id)
        shown.forEach { card -> key(cards.handle, card.key, card.binding) {
            // A11 hook: the card a project page opened this conversation onto is brought into view once drawn.
            val requester = remember { BringIntoViewRequester() }
            if (focus != null && CardFocus.matches(focus, card.key)) LaunchedEffect(focus, card.key) {
                requester.bringIntoView(); CardFocus.spend(session.id)
            }
            Box(Modifier.bringIntoViewRequester(requester)) {
                val preview = CardPreviews.preview(card)
                val fresh = cards.fresh(session, card)
                val result = results[card.key]?.takeIf { it.binding == card.binding } ?: CardActionState()
                // Decide it myself opens a revision waiting for the coordinator into its evidence card, here in place, and that
                // card is what is pressed (`CoordinatorQueue`).
                var decidingMyself by rememberSaveable { mutableStateOf(false) }
                val drawn = (if (decidingMyself) CoordinatorQueue.decideMyself(card) else null) ?: card
                val submit = { verb: CardVerb, input: CardInput ->
                    if (verb == CardVerb.DECIDE_MYSELF) decidingMyself = true else cards.actions.submit(cards.handle, drawn, verb, input); Unit }
                when {
                    // A08-2: a long decision is a compact preview here, answered in its full-height review.
                    preview != null -> CardPreviewView(card, preview) { cards.open(card.key) }
                    // A11b hook: the coordinator's request draws the start card (iOS `StartProjectCardView`), not the generic card.
                    card.family == CardFamily.START -> CoordinatorStartCard(card, session.snapshot?.standing.orEmpty(), fresh, result, open, discuss, submit)
                    CoordinatorQueue.isSent(card) -> SentToCoordinatorLine(card)
                    else -> BusinessCard(drawn, fresh, result, open, discuss, submit)
                }
            }
        } }
        // A11c: the project's closing card, whole, in the conversation that coordinates the project (iOS `ProjectDoneCardView`: a
        // session's `projectId` is set on coordinators alone).
        session.snapshot?.detail?.let { detail -> detail.text("projectId")?.let { coordinated ->
            // The needs-you bar points at this card while it asks; brought into view as the rail's cards are.
            val requester = remember { BringIntoViewRequester() }
            val key = NeedsYouLogic.doneKey(coordinated)
            if (focus != null && CardFocus.matches(focus, key)) LaunchedEffect(focus, key) {
                requester.bringIntoView(); CardFocus.spend(session.id)
            }
            Box(Modifier.bringIntoViewRequester(requester)) {
                CoordinatorDoneCard(app, cards.handle, session.id, coordinated, detail, session.snapshot?.standing.orEmpty(), session.fresh)
            }
        } }
        cards.merged.filter { it.text("state") == "MERGED" }.forEach { receipt ->
            Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Text("Merged", style = MaterialTheme.typography.titleSmall)
                    CardFields(receipt, listOf("sourceRef", "sourceSha", "upstreamRef", "tasks", "merged"), open)
                }
            }
        }
        // A08-6: what this conversation created is the Tasks card above the composer (`SessionTasksCard`), with what its watches wait on.
        session.snapshot?.background?.forEach { job ->
            DetailFold("Background work · ${job.text("description") ?: job.text("taskId") ?: job.text("id") ?: ""}") {
                CardFields(job, listOf("status", "command", "description", "latestOutput", "output", "outputTail", "exitCode", "killReason"), open)
            }
        }
    }
}

/** A revision that waited for its coordinator and has been handed to it (`CoordinatorQueue`): one line where its card was, saying
 * when (iOS's capsule). */
@Composable
private fun SentToCoordinatorLine(card: InteractionCard) {
    Box(Modifier.fillMaxWidth().testTag(card.key), contentAlignment = Alignment.Center) {
        Text(CoordinatorQueue.sentLine(card.source.text("deliveredAt")?.let { OwnerReview.receiptTime(it) }),
            Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The tone's colour (iOS `approvalChrome`'s tint). */
@Composable
internal fun PreviewTone.color(): Color = when (this) {
    PreviewTone.BLUE -> MaterialTheme.colorScheme.primary
    PreviewTone.PURPLE -> Color(0xFF8E44AD)
    PreviewTone.ORANGE -> LocalOrbitColors.current.needsYou
}

/**
 * A long decision as the conversation shows it (A08-2; iOS `ApprovalReviewLayout`'s compact preview): one press — its heading, its
 * summary in three lines, then "View details & act" — that opens the full review. No provenance, no fields, no buttons here; a
 * preview that asks nothing any more is dimmed and says "View details".
 */
@Composable
internal fun CardPreviewView(card: InteractionCard, preview: CardPreview, onOpen: () -> Unit) {
    val tone = preview.tone.color()
    Box(Modifier.testTag(card.key)) { Column(Modifier.fillMaxWidth().alpha(if (preview.dimmed) 0.72f else 1f)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
        .clickable(role = Role.Button, onClick = onOpen).testTag("${card.key}:preview").padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(22.dp).background(tone.copy(alpha = 0.16f), RoundedCornerShape(6.dp)))
            Text(preview.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            preview.badge?.let {
                Text(it, Modifier.background(tone.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1)
            }
        }
        if (preview.summary.isNotBlank()) Text(preview.summary, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
        HorizontalDivider(color = tone.copy(alpha = 0.28f))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(preview.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.primary)
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
        }
    } }
}

/**
 * The full-height review a preview opens (A08-2; iOS `ApprovalReviewSheet`): the card whole, its buttons pinned under it, a ✕ that
 * closes it. Hosted by the reader outside the transcript's rows; the answers typed in it are kept per card version while it closes
 * and opens again ([states]). After this window's own press it says so — "Sending your answer…", then "Answer sent" or "Decision
 * recorded", closing itself — and a request that went away says that instead of drawing nothing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardReviewSheet(cards: SessionCardsModel, states: SaveableStateHolder, open: (String) -> Unit, discuss: ((String) -> Unit)?) {
    val key = cards.review ?: return
    val (app, session) = cardSession() ?: return
    val results by cards.actions.state.collectAsState()
    val card = cards.shown(session).firstOrNull { it.key == key }
    val result = card?.let { results[it.key]?.takeIf { r -> r.binding == it.binding } } ?: CardActionState()
    val phase = card?.let { CardPreviews.phase(it, result, cards.pressed) } ?: CardPreviews.Phase.CARD
    val preview = card?.let { CardPreviews.preview(it) }
    // Read again as it opens: what it shows is the server's now, not the preview's.
    LaunchedEffect(key) { app.realtime.refreshSession() }
    LaunchedEffect(phase) {
        if (phase == CardPreviews.Phase.ANSWER_SENT || phase == CardPreviews.Phase.DECISION_RECORDED) { delay(1_200); cards.close() }
    }
    val title = when {
        card == null -> CardPreviews.requestClosed
        phase == CardPreviews.Phase.SENDING -> CardPreviews.sendingTitle
        phase != CardPreviews.Phase.CARD -> CardPreviews.answeredTitle
        else -> preview?.title ?: card.title
    }
    ModalBottomSheet(onDismissRequest = { cards.close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        dragHandle = { BottomSheetDefaults.DragHandle() }) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().imePadding().testTag("card-review")) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f).testTag("card-review:title"), style = MaterialTheme.typography.titleMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = { cards.close() }, Modifier.testTag("card-review:close")) {
                    Icon(painterResource(R.drawable.ic_close), CardPreviews.close)
                }
            }
            // A refusal since it opened reads at the top, where the eye is after a press (iOS's banner).
            if (card != null && phase == CardPreviews.Phase.CARD && cards.pressed != null && !result.busy && !result.settled) result.message?.let {
                Text(it, Modifier.fillMaxWidth().background(LocalOrbitColors.current.needsYou.copy(alpha = 0.12f)).padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("card-review:banner"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou, maxLines = 4)
            }
            HorizontalDivider()
            when {
                card == null -> Centered { Text(CardPreviews.noLongerWaiting, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyLarge) }
                phase == CardPreviews.Phase.SENDING -> Centered {
                    CircularProgressIndicator()
                    Text(CardPreviews.sending, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                phase == CardPreviews.Phase.ANSWER_SENT -> Receipt(CardPreviews.answerSent, CardPreviews.answerSentDetail)
                phase == CardPreviews.Phase.DECISION_RECORDED -> Receipt(CardPreviews.decisionRecorded, CardPreviews.decisionRecordedDetail)
                else -> states.SaveableStateProvider("review:${card.key}") {
                    val fresh = cards.fresh(session, card)
                    // A hand-off to the composer closes the review first: the reply is typed under the conversation.
                    val talk = discuss?.let { into -> { context: String -> cards.close(); into(context) } }
                    val submit = { verb: CardVerb, input: CardInput -> cards.pressed = verb; cards.actions.submit(cards.handle, card, verb, input); Unit }
                    if (card.family == CardFamily.START) Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                        CoordinatorStartCard(card, session.snapshot?.standing.orEmpty(), fresh, result, open, talk, submit)
                    } else BusinessCard(card, fresh, result, open, talk, submit, review = true)
                }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally, content = content)
}

/** The review's receipt: what the press did, in the words iOS's `ReviewReceipt` uses, until it closes itself. */
@Composable
private fun Receipt(title: String, detail: String) = Centered {
    Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(44.dp), tint = LocalOrbitColors.current.success)
    Text(title, Modifier.testTag("card-review:receipt"), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
}

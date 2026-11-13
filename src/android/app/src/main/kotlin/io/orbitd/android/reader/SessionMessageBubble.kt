package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.cards.BackgroundWakeCard
import io.orbitd.android.core.cards.CardAuthority
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** Every word another session's message adds around its words (web `lib/sessionMessage.ts` and `lib/sessionRequest.ts`). */
internal object SessionMessageCopy {
    const val FROM = "From"
    const val UNTITLED = "Untitled session"
    /** No longer shown: the caption already says who sent it. Read out by a screen reader over the bubble. */
    const val NOT_YOU = "Sent by another Orbit session, not by you"
    const val OPEN_TASK = "Its task ↗"
    const val ASKS = "Asked for a reply"
    const val DUE = "due"
    val stateLabel = mapOf(
        "OPEN" to "Waiting for a reply",
        "REPLIED" to "Replied",
        "NO_REPLY" to "Closed: went idle without replying",
        "RECIPIENT_ENDED" to "Closed: this session ended",
        "EXPIRED" to "Closed: the deadline passed",
        "UNDELIVERED" to "Closed: never delivered",
    )
    /** The states drawn in the warning tone; every other word on the foot stays grey. */
    val problemStates = setOf("NO_REPLY", "RECIPIENT_ENDED", "EXPIRED", "UNDELIVERED")

    fun title(source: JsonObject) = source.text("fromTitle")?.trim()?.ifEmpty { null } ?: UNTITLED
}

/**
 * Another Orbit session's message, drawn the way a chat draws somebody else's (docs/mocks/session-message-bubble, owner 2026-11-12; web
 * `SessionMessageCard`): who sent it on one grey line, their words in a bubble on the left that hugs them (720 dp at most), and everything
 * else on one grey foot line — when, its task, what the message asks and where that stands, and what Orbit attached.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SessionMessageBubble(source: JsonObject, event: RunEvent?, open: (String) -> Unit, words: String = event?.personWords().orEmpty(),
    note: String? = event?.fields?.text("controlPlaneNote")?.takeIf { it.isNotBlank() }, revealed: Boolean = false) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val quiet = secondary.copy(alpha = 0.75f)
    val requestId = source.text("requestId")
    val request = sessionRequest(requestId)
    var noteOpen by rememberSaveable(note) { mutableStateOf(false) }
    Column(Modifier.widthIn(max = 720.dp).testTag("session-message"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_sessions), null, Modifier.padding(end = 4.dp).size(14.dp), tint = quiet)
            Text("${SessionMessageCopy.FROM} ", style = MaterialTheme.typography.labelMedium, color = secondary)
            val session = source.text("fromSessionId")
            Text(SessionMessageCopy.title(source), Modifier.weight(1f, fill = false).testTag("session-message:from").then(
                if (session != null) Modifier.clickable(role = Role.Button) { open("orbit-session:$session") } else Modifier),
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = secondary)
            source.text("fromAgentName")?.takeIf { it.isNotBlank() }?.let {
                Text(" · $it", style = MaterialTheme.typography.labelMedium, color = quiet, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Column(Modifier.testTag("session-message:bubble").clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp).semantics { contentDescription = SessionMessageCopy.NOT_YOU }) {
            if (words.isNotBlank()) SessionMessageBody(words, open, revealed)
        }
        // One grey line, its entries joined by " · ", wrapping where the column is narrow.
        val items = buildList<@Composable (String) -> Unit> {
            event?.ts?.let { BackgroundWakeCard.relative(it) }?.let { at -> add { sep -> FootText(at + sep, quiet) } }
            source.text("fromTaskId")?.takeIf { it.isNotBlank() }?.let { task ->
                add { sep -> FootText(SessionMessageCopy.OPEN_TASK + sep, quiet,
                    Modifier.clickable(role = Role.Button) { open("orbit-task:$task") }.testTag("session-message:task")) }
            }
            if (requestId != null) {
                add { sep -> FootText(SessionMessageCopy.ASKS + sep, quiet) }
                val state = request?.text("state")
                request?.text("replyBy")?.takeIf { state == "OPEN" }?.let { OwnerReview.receiptTime(it) }?.let { due ->
                    add { sep -> FootText("${SessionMessageCopy.DUE} $due$sep", quiet) }
                }
                state?.let { SessionMessageCopy.stateLabel[it] }?.let { label ->
                    val tone = when (state) {
                        in SessionMessageCopy.problemStates -> LocalOrbitColors.current.needsYou
                        "OPEN" -> MaterialTheme.colorScheme.primary
                        else -> quiet
                    }
                    add { sep -> FootText(label + sep, tone) }
                }
            }
            note?.let { add { sep -> AttachedNoteLabel(it, noteOpen, sep, quiet) { noteOpen = !noteOpen } } }
        }
        if (items.isNotEmpty()) FlowRow(Modifier.testTag("session-message:foot")) {
            items.forEachIndexed { index, item -> item(if (index < items.lastIndex) " · " else "") }
        }
        if (noteOpen) note?.let { AttachedNotePanel(it) }
    }
}

@Composable
private fun FootText(text: String, color: Color, modifier: Modifier = Modifier) =
    Text(text, modifier, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1)

/** The request this message makes, read live behind the conversation's snapshot reads; null until read, or when it cannot be. */
@Composable
private fun sessionRequest(requestId: String?): JsonObject? {
    val resources = LocalReaderResources.current
    val app = LocalContext.current.applicationContext as? OrbitApplication
    val live = app?.realtime?.state?.collectAsState()?.value
    val authorized = resources != null && live?.handle === resources.handle && live?.session?.id == resources.sessionId &&
        live?.session?.fresh == true && live?.session?.accessDenied == false
    var request by remember(requestId) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(resources, requestId, authorized, live?.session?.snapshotReads) {
        if (!authorized || requestId == null) return@LaunchedEffect
        try { request = CardAuthority(resources!!.auth, resources.handle).get(listOf("session-requests", requestId)) as? JsonObject }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { request = null }
    }
    return request
}

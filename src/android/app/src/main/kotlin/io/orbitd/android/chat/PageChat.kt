package io.orbitd.android.chat

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.drive.ChatFabState
import io.orbitd.android.ui.LocalOrbitColors

// A chat beside a page (board docs/mocks/drive-chat/02-native.html frames 9–12, "Android: the same as iPhone, with Material's parts"):
// the round button and the non-modal sheet, written once and configured by where the chat comes from — Drive today. Inside it the
// session page's own transcript and composer draw the conversation (SessionReader with a [ReaderChat]).

/** What a page's chat says, by where it comes from: the Drive chat's words are DriveChatCopy's. */
data class ChatOrigin(
    val newChat: String,
    val history: String,
    val noHistory: String,
    val emptyHint: String,
    val emptyNote: String,
    val placeholder: String,
    val examples: List<String>,
    val runsIn: String,
    val openSession: String,
    val close: String,
)

/** One card a page's chat draws in the conversation, after the last row of the turn it came from (`turnId`). */
class ReaderChatCard(val key: String, val turnId: String, val content: @Composable () -> Unit)

/**
 * The session reader drawn inside a page's chat sheet: no page bar of its own, the chat's cards placed with their turns ([cards];
 * those whose turn is not among the rows read go under the conversation), and the composer's placeholder and chips.
 */
class ReaderChat(val placeholder: String, val chips: @Composable () -> Unit, val cards: List<ReaderChatCard>)

/** The board's metrics: the button 56 dp, 16 from the edges; the sheet's half detent a little over half the page. */
object ChatMetrics {
    val fab = 56.dp
    val fabEdge = 16.dp
    const val HALF = 0.56f
}

/**
 * The round button (board frame 4, Android 56 dp): its icon is its look — a chat bubble, a spinner while a turn runs, a red count when
 * something waits on the owner, a green check when work finished while the sheet was closed. [label] is what TalkBack reads.
 */
@Composable
fun ChatFab(state: ChatFabState, label: String, count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.size(ChatMetrics.fab + 8.dp).testTag("chat-fab").semantics { contentDescription = label }) {
        FloatingActionButton(onClick = onClick, Modifier.size(ChatMetrics.fab).align(Alignment.BottomStart), shape = CircleShape,
            containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) {
            if (state == ChatFabState.WORKING) CircularProgressIndicator(Modifier.size(26.dp).testTag("chat-fab-working"),
                color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.5.dp)
            else Icon(painterResource(R.drawable.ic_chat), null, Modifier.size(28.dp))
        }
        when (state) {
            ChatFabState.NEEDS_YOU -> Badge(Modifier.align(Alignment.TopEnd).testTag("chat-fab-count"), containerColor = Color(0xFFD93025),
                contentColor = Color.White) { Text(if (count > 99) "99+" else "$count", fontSize = 11.sp, fontWeight = FontWeight.SemiBold) }
            ChatFabState.UPDATED -> Box(Modifier.align(Alignment.TopEnd).size(20.dp).background(LocalOrbitColors.current.success, CircleShape)
                .testTag("chat-fab-updated"), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_check), null, Modifier.size(13.dp), tint = Color.White)
            }
            else -> Unit
        }
    }
}

/** The sheet's own grey, under the white composer card (board `.sheet`). */
@Composable
fun chatSheetColor(): Color = if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) Color(0xFFF3F4F8) else Color(0xFF1B1C1F)

/**
 * The chat's sheet (board frames 10–12): non-modal — no scrim, so the page behind still scrolls and opens folders, and the chips follow
 * it — at half or full height, dragged between the two by its handle; the system back closes it. [expanded] is the full detent, for
 * which the page folds its bar away.
 */
@Composable
fun ChatSheet(expanded: Boolean, onExpanded: (Boolean) -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit) {
    BackHandler(onBack = onClose)
    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        val full = maxHeight
        val half = maxHeight * ChatMetrics.HALF
        var drag by remember { mutableStateOf(0.dp) }
        val target = (if (expanded) full else half) - drag
        val height by animateDpAsState(target.coerceIn(half * 0.6f, full), label = "chat-sheet")
        val density = LocalDensity.current
        val dragState = rememberDraggableState { delta -> drag += with(density) { delta.toDp() } }
        Column(Modifier.fillMaxWidth().height(if (drag != 0.dp) target.coerceIn(half * 0.6f, full) else height)
            .shadow(12.dp, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
            .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)).background(chatSheetColor())
            .imePadding().testTag(if (expanded) "chat-sheet-full" else "chat-sheet-half")) {
            Box(Modifier.fillMaxWidth().height(22.dp).draggable(dragState, Orientation.Vertical, onDragStopped = {
                val moved = drag
                drag = 0.dp
                when {
                    !expanded && moved < -48.dp -> onExpanded(true)
                    expanded && moved > 48.dp -> onExpanded(false)
                    !expanded && moved > 96.dp -> onClose()
                }
            }).clickable(onClickLabel = if (expanded) "Half height" else "Full height") { onExpanded(!expanded) }.testTag("chat-sheet-handle"),
                contentAlignment = Alignment.Center) {
                Box(Modifier.size(32.dp, 4.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f), RoundedCornerShape(2.dp)))
            }
            content()
        }
    }
}

/** One row of the title's history menu: a chat as the list names it. */
data class ChatHistoryRow(val id: String, val title: String, val detail: String?)

/**
 * The sheet's head: the chat's title, which opens a menu of New chat and the history (no separate +, board frame 6 ①), → to the full
 * session page, and ✕.
 */
@Composable
fun ChatSheetHeader(origin: ChatOrigin, title: String, history: List<ChatHistoryRow>, current: String?, newChat: () -> Unit,
    pick: (String) -> Unit, openSession: (() -> Unit)?, close: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = origin.history) { menu = true }.padding(vertical = 6.dp)
                .testTag("chat-title"), verticalAlignment = Alignment.CenterVertically) {
                Text(title, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
            }
            DropdownMenu(menu, { menu = false }, Modifier.widthIn(min = 260.dp).testTag("chat-history")) {
                DropdownMenuItem(text = { Text(origin.newChat) }, onClick = { menu = false; newChat() },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_plus), null) }, modifier = Modifier.testTag("chat-new"))
                HorizontalDivider()
                Text(origin.history, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (history.isEmpty()) Text(origin.noHistory, Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                history.forEach { row ->
                    DropdownMenuItem(text = {
                        Column {
                            Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                fontWeight = if (row.id == current) FontWeight.SemiBold else null)
                            row.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }, onClick = { menu = false; pick(row.id) }, modifier = Modifier.testTag("chat-history-row"))
                }
            }
        }
        IconButton(onClick = { openSession?.invoke() }, enabled = openSession != null, modifier = Modifier.testTag("chat-open-session")) {
            Icon(painterResource(R.drawable.ic_arrow_forward), origin.openSession)
        }
        IconButton(onClick = close, Modifier.testTag("chat-close")) { Icon(painterResource(R.drawable.ic_close), origin.close) }
    }
}

/** A chip of the composer's row (board `Folder · Scans ✕`): what goes with the message, crossed out by its ✕. */
@Composable
fun ChatChip(label: String, icon: Int, remove: String, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.secondaryContainer)
        .padding(start = 10.dp, end = 4.dp).height(32.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(painterResource(icon), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 220.dp))
        Box(Modifier.size(28.dp).clip(CircleShape).clickable(onClickLabel = remove, onClick = onRemove).semantics { contentDescription = remove },
            contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_close), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
        }
    }
}

/**
 * A new chat's empty state (board frame 10): where it runs, the two lines that say what it is for, and the examples — each fills the box
 * and sends nothing. [runsIn] is the workspace's row with its menu, drawn by the page.
 */
@Composable
fun ChatEmptyState(origin: ChatOrigin, runsIn: @Composable () -> Unit, showExamples: Boolean, useExample: (String) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        runsIn()
        Spacer(Modifier.height(4.dp))
        Text("${origin.emptyHint}\n${origin.emptyNote}", Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp, lineHeight = 21.sp)
        if (showExamples) origin.examples.forEach { example ->
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(example, Modifier.clip(RoundedCornerShape(20.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(20.dp))
                    .clickable { useExample(example) }.padding(horizontal = 14.dp, vertical = 8.dp).testTag("chat-example"),
                    fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
            }
        }
    }
}

/** A card of the conversation (board `.dcard`): a tinted head with its title and state, the body, and the actions under a divider. */
@Composable
fun ChatCard(title: String, state: String?, tone: ChatCardTone, modifier: Modifier = Modifier, body: @Composable ColumnScope.() -> Unit,
    actions: (@Composable ColumnScope.() -> Unit)? = null) {
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val (head, word) = when (tone) {
        ChatCardTone.DONE -> (if (dark) Color(0xFF173A26) else Color(0xFFE3F3E8)) to LocalOrbitColors.current.success
        ChatCardTone.NEEDS_YOU -> (if (dark) Color(0xFF3D2E12) else Color(0xFFFFF3E0)) to LocalOrbitColors.current.needsYou
        ChatCardTone.QUIET -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surface)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp))) {
        Row(Modifier.fillMaxWidth().background(head).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            state?.let { Text(it, color = word, fontWeight = FontWeight.Medium, fontSize = 14.sp) }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = body)
        if (actions != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = actions)
        }
    }
}

enum class ChatCardTone { DONE, NEEDS_YOU, QUIET }

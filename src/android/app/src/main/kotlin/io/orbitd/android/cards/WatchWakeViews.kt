package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/** The name this conversation holds for one target a watch's wake reports moved, by the watch and the target — null when it holds
 * none, and the line then names the target by its kind and the last eight of its id. Provided by the reader. */
val LocalWatchTargetNames = compositionLocalOf<(String, JsonObject) -> String?> { { _, _ -> null } }

/**
 * A target's title, by either spelling of its id (OrbitKit `PublicID.storageKey`) — the wake names it by its UUID, the reads this
 * client holds by its public id: the watch's own record of its targets first, which the server fills in for every target it can
 * read; then the session list, for a session; then this conversation's own Tasks card, for a task. Android holds no account-wide
 * task list beside the conversation, which is where iOS looks between the last two.
 */
internal fun watchTargetName(watchId: String, target: JsonObject, watches: List<JsonObject>, sessionTitle: (String) -> String?,
    created: JsonObject?): String? {
    val id = target.text("id") ?: return null
    fun key(value: String) = ObjectId.canonical(value) ?: value
    fun same(value: String?) = value != null && key(value) == key(id)
    watches.firstOrNull { watch -> watch.text("id")?.let { key(it) == key(watchId) } == true }?.objects("targets")
        ?.firstOrNull { same(it.text("targetResourceId")) }?.text("targetTitle")?.takeIf { it.isNotEmpty() }?.let { return it }
    return when (target.text("kind")) {
        "SESSION" -> sessionTitle(id)?.takeIf { it.isNotEmpty() }
        "TASK" -> created?.objects("items")?.firstOrNull { same(it.text("id")) }?.text("title")?.takeIf { it.isNotEmpty() }
        else -> null
    }
}

/**
 * A turn a watch queued into this session, as one event line in the agent's stream (A08-14; iOS `WatchWakeCardView`) — the grammar a
 * background job's news uses (`BackgroundWakeLine`): the watch's eye, or a red mark when a target it saw failed; what happened, which
 * target moved, how it came out, when, and "Details". Tapping it opens why it fired, each target that moved (opening it, a failed one
 * red), who queued the turn, the way to the watch and what the agent received. Several targets keep the failed ones in view while
 * folded. A wake still queued is drawn dashed with the queue's own line under it, and withdrawing it asks first.
 */
@Composable
internal fun WatchWakeLine(wake: JsonObject, ts: String?, open: (String) -> Unit, undelivered: Boolean = false, queued: Boolean = false,
    onWithdraw: (() -> Unit)? = null) {
    var expanded by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    val names = LocalWatchTargetNames.current
    val watchId = wake.text("watchId").orEmpty()
    val name = { target: JsonObject -> names(watchId, target) }
    val failed = WatchWakeCard.isFailed(wake)
    val red = MaterialTheme.colorScheme.error
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val label = MaterialTheme.typography.bodySmall
    val only = WatchWakeCard.targets(wake).singleOrNull()
    val lineName = WatchWakeCard.lineName(wake, only?.let(name))
    val mark = @Composable {
        if (failed) Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(14.dp).testTag("watch-wake:failed"), tint = red)
        else Icon(painterResource(R.drawable.ic_eye), null, Modifier.size(14.dp).testTag("watch-wake:eye"), tint = secondary)
    }
    val title = @Composable { Text(WatchWakeCard.title(wake.text("state")), style = label, color = if (failed) red else secondary, maxLines = 1) }
    val nameText = @Composable { modifier: Modifier ->
        lineName?.let { Text(it, modifier.testTag("watch-wake:name"), style = label, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
            maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
    val closing = @Composable {
        WatchWakeCard.lineStatus(wake)?.let {
            Text(it, Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp)
                .testTag("watch-wake:status"), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary, maxLines = 1)
        }
        ts?.let { BackgroundWakeCard.relative(it) }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1) }
        Text(WatchWakeCard.details, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp).rotate(if (expanded) 90f else 0f), tint = secondary.copy(alpha = 0.6f))
    }
    Column(Modifier.fillMaxWidth().testTag("watch-wake"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Dashed while it is still queued, so the one line reads as two states rather than as two things.
        Box(if (queued) Modifier.dashedBorder(secondary.copy(alpha = 0.5f), 6.dp).testTag("watch-wake:queued") else Modifier) {
            FitsOrStack(Modifier.fillMaxWidth().clickable(role = Role.Button) { expanded = !expanded }.padding(horizontal = 4.dp, vertical = 3.dp)
                .testTag("watch-wake:line"),
                wide = { Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { mark(); title(); nameText(Modifier); closing() } },
                narrow = {
                    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { mark(); title() }
                        nameText(Modifier.padding(start = 20.dp))
                        Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { closing() }
                    }
                })
        }
        if (expanded) WatchWakeFold(wake, watchId, name, open)
        // The fold lists every target, these among them; closed, the failures stay in view.
        val (failures, more) = WatchWakeCard.failures(wake)
        if (!expanded && failures.isNotEmpty()) Column(Modifier.padding(start = 20.dp).testTag("watch-wake:failures"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            failures.forEach { ChangedTarget(it, name(it), open) }
            if (more > 0) Text(WatchWakeCard.moreTargets(more), style = MaterialTheme.typography.labelSmall, color = secondary)
        }
        if (undelivered) Text(WatchWakeCard.undelivered, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall,
            color = LocalOrbitColors.current.needsYou)
        onWithdraw?.let {
            Row(Modifier.padding(start = 20.dp).testTag("watch-wake:queue"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(WatchWakeQueue.status, style = MaterialTheme.typography.labelSmall, color = secondary)
                TextButton(onClick = { confirming = true }, Modifier.testTag("watch-wake:withdraw")) {
                    Text(WatchWakeQueue.withdraw, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
    if (confirming && onWithdraw != null) AlertDialog(onDismissRequest = { confirming = false },
        title = { Text(WatchWakeQueue.confirmTitle) }, text = { Text(WatchWakeQueue.consequence) },
        confirmButton = { TextButton(modifier = Modifier.testTag("watch-wake:confirm-withdraw"), onClick = { confirming = false; onWithdraw() }) {
            Text(WatchWakeQueue.withdraw, color = MaterialTheme.colorScheme.error)
        } },
        dismissButton = { TextButton(modifier = Modifier.testTag("watch-wake:keep"), onClick = { confirming = false }) { Text(WatchWakeQueue.keep) } })
}

/** What the line carried, opened: why it fired, each target that moved, who queued the turn, the way to the watch and what the agent
 * read — hung off a rule. */
@Composable
private fun WatchWakeFold(wake: JsonObject, watchId: String, name: (JsonObject) -> String?, open: (String) -> Unit) {
    var raw by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(start = 20.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(secondary.copy(alpha = 0.25f)))
        Column(Modifier.padding(start = 10.dp).testTag("watch-wake:fold"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(WatchWakeCard.why(wake), Modifier.testTag("watch-wake:why"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f))
            val (shown, more) = WatchWakeCard.changes(wake)
            if (shown.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                shown.forEach { ChangedTarget(it, name(it), open) }
                if (more > 0) Text(WatchWakeCard.moreTargets(more), style = MaterialTheme.typography.labelSmall, color = secondary)
            }
            Text(WatchWakeCard.meta(wake), Modifier.testTag("watch-wake:meta"), style = MaterialTheme.typography.labelSmall, color = secondary)
            if (watchId.isNotEmpty()) Text(WatchWakeCard.viewWatch, Modifier.clickable(role = Role.Button) { open("orbit://watch/$watchId") }
                .heightIn(min = 32.dp).testTag("watch-wake:view-watch"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            Disclosure(WatchWakeCard.rawSummary, raw, "watch-wake:raw") { raw = !raw }
            if (raw) SelectionContainer {
                Text(wake.text("text").orEmpty(), Modifier.testTag("watch-wake:received"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = secondary)
            }
        }
    }
}

/** One target the wake reports moved, by the name this conversation holds for it, opening it; a failed one in the error tone. */
@Composable
private fun ChangedTarget(target: JsonObject, name: String?, open: (String) -> Unit) {
    val id = target.text("id").orEmpty()
    val line = WatchWakeCard.changedLine(target, name)
    val destination = when (target.text("kind")) { "SESSION" -> "orbit-session:$id"; "TASK" -> "orbit-task:$id"; else -> null }
    val tone = if (WatchWakeCard.targetFailed(target)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    if (destination != null) Text(line, Modifier.clickable(role = Role.Button) { open(destination) }.testTag("watch-wake:target:$id"),
        style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis)
    else Text(line, Modifier.testTag("watch-wake:target:$id"), style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

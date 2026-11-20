@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.ui.LocalOrbitColors

/** Scrolls the conversation to an exception item's own card and answers whether it holds one (board card-ui-polish ②; iOS
 * `ConsoleModel.revealOpenItemCard`). Null outside a conversation, where the delivery card then says the item card is not here. */
internal val LocalRevealItemCard = compositionLocalOf<((String) -> Boolean)?> { null }

/**
 * An exception item's delivery to the coordinator, drawn as the card it is everywhere else (iOS `OpenItemDeliveryCardView`, web
 * `OpenItemDeliveryCard.tsx`): what kind of item it is and what it is about, the facts it was opened with — the files a merge conflicted
 * on, the check that disagreed, the attempt that failed — whether the work is on the target branch, and a link to the item's own card,
 * where its doors are pressed. The foot says when it was sent; the words the agent read, and the item's id with them, are one disclosure
 * away. Every word is OrbitKit's (`OpenItemDeliveryCopy`).
 */
@Composable
internal fun OpenItemDeliveryCardView(card: InteractionCard, event: RunEvent?, open: (String) -> Unit) {
    val delivery = card.source
    val key = card.key
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val tint = MaterialTheme.colorScheme.primary
    val wash = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f)
    val state = event?.turnId?.let { LocalSteerDeliveries.current[it] } ?: event?.fields?.text("delivery")
    val undelivered = state == "failed" || state == "unconfirmed"
    val reveal = LocalRevealItemCard.current
    var allFiles by rememberSaveable(key) { mutableStateOf(false) }
    var showingRaw by rememberSaveable(key) { mutableStateOf(false) }
    // Asked for the item's own card and the conversation holds none: the link becomes the sentence.
    var cardMissing by remember(key) { mutableStateOf(false) }
    val task = delivery.obj("task")
    // The app's own doors, only for an id that can name one (OrbitKit's `link`): anything else is drawn as words, or not at all.
    val taskId = task?.text("id")?.takeIf { ObjectId.canonical(it) != null }
    val sessionId = task?.text("sessionId")?.takeIf { ObjectId.canonical(it) != null }
    val landingId = delivery.text("landingSessionId")?.takeIf { it.isNotEmpty() }
    val files = delivery.strings("files")
    Column(Modifier.conversationCard().testTag(key).background(tone.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
        .border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // "Exception item · Merge conflict" — what this turn is, before what it is about.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(14.dp), tint = tone)
            Text(OpenItemDeliveryCopy.header, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                color = tone, maxLines = 1)
            Text(OpenItemDeliveryCopy.kindLabel(delivery.text("kind")), Modifier.testTag("$key:kind").background(wash, RoundedCornerShape(50))
                .border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        }
        Text(delivery.text("title").orEmpty(), Modifier.testTag("$key:title"), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
        task?.let {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(OpenItemDeliveryCopy.taskLabel, style = MaterialTheme.typography.bodySmall, color = secondary)
                Text(it.text("title").orEmpty(), Modifier.weight(1f).testTag("$key:task")
                    .then(if (taskId != null) Modifier.clickable(role = Role.Button) { open("orbit-task:$taskId") } else Modifier),
                    style = MaterialTheme.typography.bodySmall, color = if (taskId != null) tint else secondary)
            }
        }
        OpenItemDeliveryCopy.headline(delivery)?.let { Text(it, Modifier.testTag("$key:headline"), style = MaterialTheme.typography.bodyMedium) }
        if (files.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SelectionContainer {
                Column(Modifier.fillMaxWidth().background(wash, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 6.dp).testTag("$key:files"),
                    verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    (if (allFiles) files else files.take(OpenItemDeliveryCopy.filesShown)).forEach {
                        Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            }
            OpenItemDeliveryCopy.filesToggle(files.size, allFiles)?.let {
                Text(it, Modifier.clickable(role = Role.Button) { allFiles = !allFiles }.testTag("$key:files-toggle"),
                    style = MaterialTheme.typography.bodySmall, color = tint)
            }
        }
        OpenItemDeliveryCopy.landingLine(delivery)?.let { (text, landed) ->
            val ink = if (landed) LocalOrbitColors.current.success else secondary
            Row(Modifier.fillMaxWidth().background(wash, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 6.dp).testTag("$key:landing"),
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                // Not a cross: a receipt nobody wrote is no evidence either way.
                if (landed) Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.padding(top = 2.dp).size(14.dp), tint = ink)
                else Text("◌", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.bodySmall, color = ink)
                Text(text, style = MaterialTheme.typography.bodySmall, color = ink)
            }
        }
        // Where the reader can go: the item's own card, scrolled to in place, then the task, the run that failed and the landing.
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (cardMissing) Text(OpenItemDeliveryCopy.itemCardNotHere, Modifier.padding(vertical = 4.dp).testTag("$key:item-card-missing"),
                style = MaterialTheme.typography.bodySmall, color = secondary)
            else DeliveryLink(OpenItemDeliveryCopy.goToItemCard, "$key:item-card") {
                cardMissing = reveal?.invoke(delivery.text("itemId").orEmpty()) != true
            }
            taskId?.let { DeliveryLink(OpenItemDeliveryCopy.openTask, "$key:open-task") { open("orbit-task:$it") } }
            sessionId?.let { DeliveryLink(OpenItemDeliveryCopy.openSession, "$key:open-session") { open("orbit-session:$it") } }
            landingId?.let { DeliveryLink(OpenItemDeliveryCopy.openLanding, "$key:open-landing") { open("orbit-session:$it") } }
        }
        OpenItemDeliveryCopy.meta(event?.ts)?.let { Text(it, Modifier.testTag("$key:foot"), style = MaterialTheme.typography.labelSmall, color = secondary) }
        // Amber, not red: the turn was handed to a session that has not confirmed it.
        if (undelivered) Text(OpenItemDeliveryCopy.undelivered, style = MaterialTheme.typography.labelSmall, color = tone)
        // The paragraph the agent was handed, exactly as it read it, folded — and the item's id with it: the id is the agent's handle.
        Row(Modifier.clickable(role = Role.Button) { showingRaw = !showingRaw }.semantics { stateDescription = if (showingRaw) "Expanded" else "Collapsed" }
            .padding(vertical = 2.dp).testTag("$key:raw"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("▸", Modifier.rotate(if (showingRaw) 90f else 0f).clearAndSetSemantics { }, style = MaterialTheme.typography.labelSmall, color = secondary)
            Text(OpenItemDeliveryCopy.rawSummary, style = MaterialTheme.typography.labelSmall, color = secondary)
        }
        if (showingRaw) Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(OpenItemDeliveryCopy.rawItemId(ObjectId.toPublic(delivery.text("itemId").orEmpty())), Modifier.testTag("$key:item-id"),
                style = MaterialTheme.typography.labelSmall, color = secondary)
            SelectionContainer {
                Text(event?.fields?.text("text").orEmpty(), Modifier.fillMaxWidth().testTag("$key:raw-text"),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
            }
        }
    }
}

@Composable
private fun DeliveryLink(label: String, tag: String, onClick: () -> Unit) {
    Text(label, Modifier.clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp).testTag(tag),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
}

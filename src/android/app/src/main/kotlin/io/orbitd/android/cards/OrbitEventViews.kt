package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.BackgroundWakeCard
import io.orbitd.android.core.cards.OrbitEvent
import io.orbitd.android.reader.describeNote
import io.orbitd.android.ui.LocalOrbitColors

/**
 * A turn Orbit opened whose note is a block no dedicated line knows ([OrbitEvent]), drawn as one line in the agent's stream in the grammar
 * a background job's news uses ([BackgroundWakeLine]; web `OrbitEventLine.tsx`, OrbitApp `OrbitEventLineView`): a neutral ⊕, "From Orbit",
 * the block's name, when, and Details opening the raw blocks the agent read. Never the reader's own row (owner rule 2026-11-16).
 */
@Composable
internal fun OrbitEventLine(note: String, ts: String?, steerState: String? = null, undelivered: Boolean = false) {
    var open by rememberSaveable(note) { mutableStateOf(false) }
    // The web opens the raw blocks with the fold: they are all there is to see.
    var raw by rememberSaveable(note) { mutableStateOf(true) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val label = MaterialTheme.typography.bodySmall
    val name = remember(note) { OrbitEvent.name(describeNote(note)) }
    val mark = @Composable { Text(OrbitEvent.mark, Modifier.clearAndSetSemantics { }.testTag("orbit-event:mark"), color = secondary,
        style = MaterialTheme.typography.labelLarge) }
    val title = @Composable { Text(OrbitEvent.title, style = label, color = secondary, maxLines = 1) }
    val nameText = @Composable { modifier: Modifier ->
        Text(name, modifier.testTag("orbit-event:name"), style = label, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    val closing = @Composable {
        ts?.let { BackgroundWakeCard.relative(it) }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1) }
        Text(OrbitEvent.details, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp).rotate(if (open) 90f else 0f), tint = secondary.copy(alpha = 0.6f))
    }
    Column(Modifier.fillMaxWidth().testTag("orbit-event"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FitsOrStack(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.padding(horizontal = 4.dp, vertical = 3.dp)
            .testTag("orbit-event:line"),
            wide = {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    mark(); title(); nameText(Modifier); closing()
                }
            },
            narrow = {
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { mark(); title() }
                    nameText(Modifier.padding(start = 20.dp))
                    Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { closing() }
                }
            })
        if (open) Row(Modifier.padding(start = 20.dp).height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(secondary.copy(alpha = 0.25f)))
            Column(Modifier.padding(start = 10.dp).testTag("orbit-event:fold"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Disclosure(OrbitEvent.rawSummary, raw, "orbit-event:raw") { raw = !raw }
                if (raw) SelectionContainer {
                    Text(note, Modifier.testTag("orbit-event:raw-text"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = secondary)
                }
            }
        }
        if (undelivered) Text(BackgroundWakeCard.undelivered, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall,
            color = LocalOrbitColors.current.needsYou)
        steerState?.let { Text(it, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall, color = secondary) }
    }
}

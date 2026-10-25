package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * What the control plane appended to a message — a reference's summary, a list's condition board, the
 * background work a returning engine is told about, a coordinator's standing role — as a compact card
 * before the reader opens exactly what the model read (iOS `AttachedNoteEntry`, 0d23b89fc). Opened, it
 * is the block verbatim and selectable; shut, it says what is attached and that it is not the person's.
 */
@Composable
internal fun AttachedNoteCard(note: String) {
    var open by rememberSaveable(note) { mutableStateOf(false) }
    val kind = remember(note) { describeNote(note) }
    val accent = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(accent.copy(alpha = 0.08f)).border(1.dp, accent.copy(alpha = 0.18f), shape)
        .padding(horizontal = 11.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.semantics(mergeDescendants = true) {
            contentDescription = "⊕ Orbit attached: $kind"; stateDescription = if (open) "Expanded" else "Collapsed"
        }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("↗", color = accent, style = MaterialTheme.typography.labelLarge, modifier = Modifier.clearAndSetSemantics { })
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("Orbit context", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text("Attached · $kind", style = MaterialTheme.typography.bodySmall, color = secondary)
            }
            Text(if (open) "⌃" else "⌄", color = secondary, style = MaterialTheme.typography.labelLarge, modifier = Modifier.clearAndSetSemantics { })
        }
        if (open) SelectionContainer {
            Text(note, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = secondary)
        } else Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                Text("Orbit context", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text("Attached to this message", style = MaterialTheme.typography.bodySmall, color = secondary)
            }
            Text("Context is kept out of your message and available when you need the full details.",
                style = MaterialTheme.typography.bodySmall, color = secondary)
            val button = RoundedCornerShape(8.dp)
            Row(Modifier.fillMaxWidth().clip(button).background(MaterialTheme.colorScheme.surface)
                .border(1.dp, accent.copy(alpha = 0.24f), button).clickable(role = Role.Button) { open = true }
                .padding(horizontal = 9.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("View full context", Modifier.weight(1f), color = accent, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text("›", color = accent, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clearAndSetSemantics { })
            }
        }
    }
}

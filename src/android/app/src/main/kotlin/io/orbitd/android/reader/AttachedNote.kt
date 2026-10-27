package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * What the control plane appended to a message — a reference's summary, a list's condition board, the
 * background work a returning engine is told about, a coordinator's standing role — named on one quiet line
 * as Orbit's rather than the person's (web `useControlPlaneNote`, iOS `AttachedNoteEntry`): in the row's meta
 * voice, ⊕ while shut and ⊖ while open, saying what is attached and nothing more, so the person's words stay
 * what the eye lands on (owner, 2026-10-27; docs/mocks/attached-context-note). Opened, it is the block
 * verbatim and selectable, on a quiet panel under the line.
 */
@Composable
internal fun AttachedNoteEntry(note: String) {
    var open by rememberSaveable(note) { mutableStateOf(false) }
    val kind = remember(note) { describeNote(note) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("${if (open) "⊖" else "⊕"} Orbit attached: $kind",
            Modifier.clickable(role = Role.Button) { open = !open }.semantics {
                contentDescription = "⊕ Orbit attached: $kind"; stateDescription = if (open) "Expanded" else "Collapsed"
            },
            color = secondary, style = MaterialTheme.typography.labelSmall)
        if (open) SelectionContainer(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f)).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Text(note, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = secondary)
        }
    }
}

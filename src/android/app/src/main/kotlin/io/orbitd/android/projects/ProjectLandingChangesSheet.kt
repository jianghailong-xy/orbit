package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.LandingChangesCopy
import io.orbitd.android.watch.WatchTime
import java.time.Instant
import kotlinx.coroutines.launch

@Composable
internal fun LandingChangesEntry(count: Int, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).testTag("project-landing-changes")
        .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(LandingChangesCopy.title, Modifier.weight(1f))
        Text("${LandingChangesCopy.rowLabel(count)} ›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LandingChangesSheet(changes: List<ProjectSettingChange>, now: Instant, enabled: Boolean,
    revert: suspend (String) -> String?, openTask: (String) -> Unit, close: () -> Unit) {
    var confirming by remember { mutableStateOf<ProjectSettingChange?>(null) }
    var reverting by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("landing-changes-sheet")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(LandingChangesCopy.title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = close) { Text("Done") }
        }
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (changes.isEmpty()) item { ChangeNote(LandingChangesCopy.empty) }
            items(changes, key = { it.id }) { change ->
                ChangeRow(change, now, enabled && !reverting, openTask) {
                    failure = null
                    confirming = change
                }
                HorizontalDivider()
            }
            item {
                ChangeNote(LandingChangesCopy.intro)
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium) }
            }
        }

        confirming?.let { change ->
            AlertDialog(onDismissRequest = { confirming = null }, title = { Text(LandingChangesCopy.confirmTitle) },
                text = { Text("${change.confirmation}\n${LandingChangesCopy.confirmConsequence}") },
                confirmButton = {
                    TextButton(onClick = {
                        confirming = null
                        reverting = true
                        scope.launch {
                            try { failure = revert(change.id) } finally { reverting = false }
                        }
                    }, enabled = enabled && !reverting, modifier = Modifier.testTag("landing-change-revert-confirm")) {
                        Text(LandingChangesCopy.revert, color = MaterialTheme.colorScheme.error)
                    }
                },
                dismissButton = { TextButton(onClick = { confirming = null }) { Text(LandingChangesCopy.cancel) } })
        }
    }
}

@Composable
private fun ChangeRow(change: ProjectSettingChange, now: Instant, enabled: Boolean, openTask: (String) -> Unit, ask: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().alpha(if (change.revertedAt == null) 1f else 0.7f).padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(change.field.label)
            if (change.field == ProjectSettingChange.Field.TASK_LANDING_CHECK_EXEMPT && change.taskId != null) {
                Text("·", color = muted)
                TextButton(onClick = { openTask(change.taskId) }, contentPadding = PaddingValues(0.dp)) { Text(LandingChangesCopy.openTask) }
            }
        }
        val old = SpanStyle(color = muted, textDecoration = TextDecoration.LineThrough, fontFamily = valueFont(change.oldValue))
        val new = SpanStyle(fontWeight = FontWeight.Bold, fontFamily = valueFont(change.newValue))
        Text(buildAnnotatedString {
            withStyle(old) { append(change.oldValue.text) }
            withStyle(SpanStyle(color = muted)) { append(" → ") }
            withStyle(new) { append(change.newValue.text) }
        }, style = MaterialTheme.typography.bodySmall)
        change.reason?.takeIf { it.isNotEmpty() }?.let { ChangeNote(it) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(change.originLabel, Modifier.background(muted.copy(alpha = 0.15f), CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
            WatchTime.format(change.createdAt, now)?.let { ChangeNote(it) }
            Spacer(Modifier.weight(1f))
            if (change.revertible) {
                OutlinedButton(onClick = ask, enabled = enabled, modifier = Modifier.testTag("landing-change-revert:${change.id}")) {
                    Text(LandingChangesCopy.revert, color = if (enabled) MaterialTheme.colorScheme.error else muted)
                }
            } else {
                change.ownerNote?.let { ChangeNote(it) }
            }
        }
        change.revertedAt?.let { ChangeNote(LandingChangesCopy.revertedLine(WatchTime.format(it, now) ?: it)) }
    }
}

private fun valueFont(value: ProjectSettingChange.Value): FontFamily? =
    if (value is ProjectSettingChange.Value.LandingCheck && !value.none && !value.command.isNullOrEmpty()) FontFamily.Monospace else null

@Composable
private fun ChangeNote(text: String) = Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)

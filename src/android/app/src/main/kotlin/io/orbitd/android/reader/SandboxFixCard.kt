package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.SandboxFixView

/**
 * Fix with an agent under the transcript's missing-bubblewrap warning (docs/mocks/codex-sandbox-fix-with-agent; web
 * `SandboxFixAction`, iOS `SandboxFixActionView`): the button and where its session runs, the agent at work, or the one that
 * already finished with the row. A transcript is history, so a handled row offers no second agent.
 */
@Composable
internal fun SandboxFixCard(console: SessionConsole) {
    val view = RunnerPage.sandboxFixView(console.runner) ?: return
    Column(
        Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .45f), RoundedCornerShape(10.dp))
            .padding(10.dp)
            .testTag("chat-sandbox-fix"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when (view) {
            is SandboxFixView.Ready -> {
                Button(onClick = console::fixSandbox, enabled = !console.sandboxFixStarting,
                    modifier = Modifier.testTag("chat-sandbox-fix:button")) { Text(RunnerCopy.FIX_WITH_AGENT) }
                view.line?.let { HintLine(it) }
                console.sandboxFixError?.let {
                    Text(it, Modifier.testTag("chat-sandbox-fix:error"), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error)
                }
            }
            is SandboxFixView.Blocked -> {
                Button(onClick = {}, enabled = false,
                    modifier = Modifier.testTag("chat-sandbox-fix:button")) { Text(RunnerCopy.FIX_WITH_AGENT) }
                HintLine(view.line)
            }
            is SandboxFixView.Fixing -> FixLine(RunnerCopy.agentFixing(view.fixing.workspaceName),
                open = { console.openSession(view.fixing.sessionId) }, dot = true)
            is SandboxFixView.Handled -> FixLine(RunnerCopy.agentFixFixed(view.workspaceName),
                open = { console.openSession(view.sessionId) })
        }
    }
}

/** Where its session would run, or why none can start: the machine page's grey line under the button. */
@Composable
private fun HintLine(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The agent's line: a dot while it is at work, then "Open session" for the session that started. */
@Composable
private fun FixLine(text: String, open: () -> Unit, dot: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (dot) Box(Modifier.padding(end = 6.dp).size(6.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
        Text(text, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = open, contentPadding = PaddingValues(horizontal = 4.dp),
            modifier = Modifier.testTag("chat-sandbox-fix:open")) {
            Text(RunnerCopy.OPEN_SESSION, style = MaterialTheme.typography.labelMedium)
        }
    }
}

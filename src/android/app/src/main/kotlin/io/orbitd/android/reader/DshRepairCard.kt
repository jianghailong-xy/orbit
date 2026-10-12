package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.management.rememberResumed
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * iOS `DshRepairCardView` (e789ce3dc, 13720e241): a DeepSeek Harness session that could not run, as the remedy rather than the runner's
 * sentence. Its credential is a DeepSeek key, never a sign-in on the runner, so a key problem is fixed on that key's page on the web —
 * then the message goes again; everything else is about the machine, whose Harness installs from here. Drawn where the failure is
 * said: on the transcript's line, and above the composer for a session still queued behind the runner.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DshRepairCard(repair: DshRuntime.Repair, console: SessionConsole) {
    val tint = LocalOrbitColors.current.needsYou
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val composer by console.composer.state.collectAsState()
    // Read again on arrival and on coming back to the app — from the web, where the key may just have been updated — and, for a key
    // problem, what a Retry would re-send.
    val resumed = rememberResumed()
    LaunchedEffect(resumed) { if (resumed) { console.reload(); if (repair.isKeyProblem) console.loadRetryText() } }
    // The runner's one install relay, followed while this card is up.
    LaunchedEffect(console.installInFlight) { while (console.installInFlight) { delay(2_000); console.reload() } }
    Column(Modifier.fillMaxWidth().background(tint.copy(alpha = .08f), RoundedCornerShape(10.dp)).padding(10.dp).testTag("dsh-repair"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("⚠", color = tint, modifier = Modifier.clearAndSetSemantics { })
            Text(repair.title(console.runnerName), color = tint, fontWeight = FontWeight.SemiBold)
        }
        Text(repair.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // The install is a state of the session's machine, said in the conversation for as long as it runs.
        if (console.installing || console.dshInstallInFlight) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text("Installing DeepSeek Harness…", style = MaterialTheme.typography.bodySmall)
        }
        console.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (repair.isKeyProblem) {
                Button(onClick = { scope.launch { runCatching { uri.openUri(console.dshKeyUrl()) } } }) { Text("Update the API key") }
                if (console.retryText.isNotEmpty()) OutlinedButton(onClick = console::retryLastMessage,
                    enabled = !console.retryInFlight && !composer.busy && !composer.waiting && composer.draft.pending == null) {
                    Text("Retry — re-send my last message")
                }
            } else if (repair == DshRuntime.Repair.NOT_INSTALLED) {
                Button(enabled = console.canInstallDsh, onClick = console::installDsh) { Text("Install") }
            }
        }
    }
}

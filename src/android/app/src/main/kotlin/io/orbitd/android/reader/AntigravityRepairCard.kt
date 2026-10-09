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
import io.orbitd.android.core.cards.AntigravityRepair
import io.orbitd.android.management.RunnerSignInCard
import io.orbitd.android.management.rememberResumed
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * iOS `AntigravityRepairCardView` (d2737d665, b173e3a28, cd8e8a41a): what keeps an Antigravity session from running, and the way
 * to fix it from here — a Google sign-in on this runner or a Gemini key in Providers, the CLI's install, a runner update. Drawn
 * where the failure is said: on the transcript's line, and above the composer for a session still queued behind the runner.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AntigravityRepairCard(repair: AntigravityRepair, console: SessionConsole) {
    val tint = LocalOrbitColors.current.needsYou
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    // Read again on arrival and on coming back to the app — from Providers, where a key may just have been connected.
    val resumed = rememberResumed()
    LaunchedEffect(resumed) { if (resumed) console.reload() }
    // The runner's one install relay, followed while this card is up.
    LaunchedEffect(console.installInFlight) { while (console.installInFlight) { delay(2_000); console.reload() } }
    Column(Modifier.fillMaxWidth().background(tint.copy(alpha = .08f), RoundedCornerShape(10.dp)).padding(10.dp).testTag("antigravity-repair"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("⚠", color = tint, modifier = Modifier.clearAndSetSemantics { })
            Text(repair.title(console.runnerName), color = tint, fontWeight = FontWeight.SemiBold)
        }
        Text(repair.body(console.runnerName, console.runnerVersion), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        val runner = console.runner
        // The session's own engine signs in with Google right here where this runner can; else what stops it, as the runner page says.
        if (repair == AntigravityRepair.NEEDS_KEY && console.provider == "antigravity") {
            if (runner != null && console.googleSignIn) RunnerSignInCard(console.management, runner, "antigravity", onSignedIn = { console.retry() })
            else console.googleSignInHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        // The install is a state of the session's machine, said in the conversation for as long as it runs (b173e3a28).
        if (console.installing || console.installInFlight) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text("Installing Antigravity CLI…", style = MaterialTheme.typography.bodySmall)
        }
        console.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (repair == AntigravityRepair.NEEDS_KEY) {
                Button(onClick = { scope.launch { runCatching { uri.openUri(console.connectGeminiUrl()) } } }) { Text("Connect Gemini") }
                val switch = console.geminiSwitch
                OutlinedButton(enabled = switch != null, onClick = { switch?.let(console::switchTo) }) { Text("Switch to Gemini") }
            } else {
                if (repair == AntigravityRepair.NOT_INSTALLED) Button(enabled = console.canInstallAntigravity, onClick = console::installAntigravity) { Text("Install") }
                val runnerId = console.runnerId
                OutlinedButton(enabled = runnerId != null, onClick = { runnerId?.let { console.openRunner(it, "antigravity") } }) { Text("Open in Providers") }
            }
        }
    }
}

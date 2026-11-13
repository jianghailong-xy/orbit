package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Update Now (docs/runner-update-drain-design.md, D4; board 3 ⑧ on the web, board 5's confirmation on the phone): install the waiting
 * release now, interrupting the owner's turns in flight, which Orbit continues with a note once the runner is back.
 */
internal object RunnerUpdateNow {
    /** What a runner declares when it takes POST /runners/:id/self-update/now (shared `SELF_UPDATE_NOW_V1`). */
    const val CAPABILITY = "self-update-now/v1"

    // The words, as the web's runnerCopy.ts says them.
    const val UPDATE_NOW = "Update Now…"
    fun title(runner: String) = "Update $runner now?"
    /** The confirmation's first paragraph, by how many turns it interrupts. */
    fun message(version: String, turns: Int): String = when (turns) {
        0 -> "No turn is running. It installs $version and restarts — usually under a minute."
        1 -> "It stops this turn, installs $version and restarts — usually under a minute. It then continues where it stopped, with a note that the update interrupted it."
        else -> "It stops these turns, installs $version and restarts — usually under a minute. Each one then continues where it stopped, with a note that the update interrupted it."
    }
    /** Below the turns. A self-update re-execs the runner, which hands background jobs on; services stop. */
    const val JOBS_NOTE = "Background jobs in those sessions keep running; services they started are stopped. Waiting work starts once it is back."
    /** The red button: `Interrupt 2 Turns and Update`; with nothing running, `Update Now`. */
    fun confirm(turns: Int): String = when (turns) {
        0 -> "Update Now"
        1 -> "Interrupt 1 Turn and Update"
        else -> "Interrupt $turns Turns and Update"
    }
    const val FAILED = "Couldn’t update the runner"
    /** The toast once the server took it. */
    fun toast(version: String) = "Restarting into $version…"

    // The transcript: the interrupt the update made (a row title, as `Interrupted — the runner restarted` is), and the turn Orbit sent
    // to continue (shared `RUNNER_UPDATE_RESUME_NOTE`).
    /** The interrupt's `reason` when Update Now stopped the turn (shared `RUNNER_UPDATE_INTERRUPT_REASON`), with `targetVersion`. */
    const val INTERRUPT_REASON = "runner_update"
    fun interruptedTitle(version: String?) = if (version.isNullOrEmpty()) "Interrupted — the runner updated" else "Interrupted — the runner updated to $version"
    const val RESUME_NOTE = "The runner update interrupted this turn; continue."
    /** Whether a user turn is the one Orbit sent to continue a turn the owner's Update Now cut — Orbit's words, not the owner's. */
    fun isResume(text: String?): Boolean = text?.startsWith("[Orbit] $RESUME_NOTE") == true

    /** Whether this runner takes the owner's Update Now: it says it does, and has a release waiting in a phase it can be pressed in. */
    fun offered(runner: JsonObject): Boolean {
        val report = runner.obj("selfUpdate") ?: return false
        return CAPABILITY in runner.strings("capabilities") && !report.str("targetVersion").isNullOrEmpty() &&
            report.str("phase") in setOf("available", "draining", "postponed")
    }

    /** The release it would install now. */
    fun version(runner: JsonObject): String = runner.obj("selfUpdate")?.str("targetVersion").orEmpty()

    /** POST /runners/:id/self-update/now and its body (shared `RunnerSelfUpdateNowRequest`): the owner's explicit "interrupt these turns". */
    fun path(runnerId: String) = listOf("runners", runnerId, "self-update", "now")
    fun request(): JsonObject = buildJsonObject { put("interruptTurns", true) }
}

/**
 * Update Now…: a button that raises the confirmation — what it does, the turns it stops with how long each has run, the jobs note, the
 * red button and Cancel. [turns] is read when it opens; [update] answers null once the server took it, or why not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RunnerUpdateNowButton(runner: String, version: String, turns: () -> List<RunnerPage.UpdateTurn>, update: suspend () -> String?,
    modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf<List<RunnerPage.UpdateTurn>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var pressed by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(pressed) {
        if (!pressed) return@LaunchedEffect
        busy = true
        failure = update()
        busy = false
        pressed = false
    }
    OutlinedButton({ shown = turns() }, modifier.testTag("runner-update-now"), enabled = !busy) { Text(RunnerUpdateNow.UPDATE_NOW) }
    shown?.let { list ->
        ModalBottomSheet({ shown = null }, Modifier.testTag("runner-update-now-sheet")) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(RunnerUpdateNow.title(runner), Modifier.fillMaxWidth().testTag("runner-update-now-sheet:title"), textAlign = TextAlign.Center,
                    fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall)
                Text(RunnerUpdateNow.message(version, list.size), Modifier.fillMaxWidth().testTag("runner-update-now-sheet:message"),
                    textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (list.isNotEmpty()) Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column {
                        list.forEachIndexed { index, turn ->
                            if (index > 0) HorizontalDivider()
                            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp).testTag("runner-update-now-turn"),
                                verticalAlignment = Alignment.CenterVertically) {
                                Text(turn.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                                turn.running?.let {
                                    Spacer(Modifier.width(8.dp))
                                    Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                                }
                            }
                        }
                    }
                }
                if (list.isNotEmpty()) Text(RunnerUpdateNow.JOBS_NOTE, Modifier.fillMaxWidth().testTag("runner-update-now-sheet:jobs"),
                    textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider()
                TextButton({ shown = null; pressed = true }, Modifier.fillMaxWidth().testTag("runner-update-now:confirm")) {
                    Text(RunnerUpdateNow.confirm(list.size), color = MaterialTheme.colorScheme.error)
                }
                TextButton({ shown = null }, Modifier.fillMaxWidth()) { Text("Cancel") }
            }
        }
    }
    failure?.let { why ->
        AlertDialog({ failure = null }, confirmButton = { TextButton({ failure = null }) { Text("OK") } },
            title = { Text(RunnerUpdateNow.FAILED) }, text = { Text(why) })
    }
}

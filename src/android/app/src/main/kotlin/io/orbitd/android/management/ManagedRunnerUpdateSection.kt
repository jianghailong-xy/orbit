package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ManagedRunnerCopy
import io.orbitd.android.composer.ManagedRunnerReader
import io.orbitd.android.composer.ManagedRunnerUpdateLogic
import kotlinx.coroutines.launch

/**
 * Orbit Cloud's Update card (docs/managed-runner-update-now-design.md, board 5): a newer build is available, restarting into it, or
 * updated. Update Now… asks the server first; a busy runner answers with the turns and background jobs it would stop, which the
 * confirmation names before the red button interrupts them. No card for a runner on the current build.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ManagedRunnerUpdateSection(reader: ManagedRunnerReader, notice: (String) -> Unit, isOwner: Boolean = true) {
    val card = ManagedRunnerUpdateLogic.card(reader.shown?.status, reader.updated, isOwner, reader.pending?.interruptedTurns) ?: return
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf<ManagedRunnerUpdateLogic.Confirmation?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    UpdateCardView(RunnerPage.UpdateCard(card.phase, card.warn, card.title, card.tag, card.body),
        if (card.canUpdateNow) { {
            OutlinedButton({
                scope.launch {
                    when (val result = reader.updateNow(interruptTurns = false, turns = 0, to = card.build)) {
                        is ManagedRunnerReader.UpdateResult.Started -> notice(ManagedRunnerCopy.restartingTitle(ManagedRunnerUpdateLogic.buildName(card.build)))
                        is ManagedRunnerReader.UpdateResult.Busy -> asking = ManagedRunnerUpdateLogic.confirmation(result.busy, card.build, System.currentTimeMillis())
                        is ManagedRunnerReader.UpdateResult.Failed -> failure = result.why
                    }
                }
            }, Modifier.testTag("runner-update-now"), enabled = !reader.busy) { Text(ManagedRunnerCopy.UPDATE_NOW) }
        } } else null)
    asking?.let { confirmation ->
        ModalBottomSheet({ asking = null }, Modifier.testTag("runner-update-now-sheet")) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(confirmation.title, Modifier.fillMaxWidth().testTag("runner-update-now-sheet:title"), textAlign = TextAlign.Center,
                    fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall)
                Text(confirmation.body, Modifier.fillMaxWidth().testTag("runner-update-now-sheet:message"), textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                confirmation.turns.forEach { turn ->
                    Text(turn, Modifier.fillMaxWidth().testTag("runner-update-now-turn"), textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
                }
                Text(confirmation.jobsNote, Modifier.fillMaxWidth().testTag("runner-update-now-sheet:jobs"), textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider()
                TextButton({
                    asking = null
                    scope.launch {
                        when (val result = reader.updateNow(interruptTurns = true, turns = confirmation.turns.size, to = confirmation.build)) {
                            is ManagedRunnerReader.UpdateResult.Started -> notice(ManagedRunnerCopy.restartingTitle(ManagedRunnerUpdateLogic.buildName(confirmation.build)))
                            else -> failure = (result as? ManagedRunnerReader.UpdateResult.Failed)?.why ?: ManagedRunnerCopy.NOW_FAILED
                        }
                    }
                }, Modifier.fillMaxWidth().testTag("runner-update-now:confirm")) { Text(confirmation.confirm, color = MaterialTheme.colorScheme.error) }
                TextButton({ asking = null }, Modifier.fillMaxWidth()) { Text("Cancel") }
            }
        }
    }
    failure?.let { why ->
        AlertDialog({ failure = null }, confirmButton = { TextButton({ failure = null }) { Text("OK") } },
            title = { Text(ManagedRunnerCopy.NOW_FAILED) }, text = { Text(why) })
    }
}

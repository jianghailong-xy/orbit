package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.SessionRunStart
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.tasks.TaskApi
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/**
 * "This run never started" (A08-5; iOS 698b707ea `SessionRunStartCard`): the one surface that answers "why is nothing happening" for
 * a run that produced nothing — first in the band above the composer, and kept while a phone types. A refused source offers "Start it
 * again", a new run of the session's task, and the press is the task's own Run door (`POST /tasks/:id/execute` with a fresh
 * `triggerId`); this conversation stays refused, so the card stays, and a new run that fails the same way draws its own card there.
 */
@Composable
internal fun SessionRunStartCard(app: OrbitApplication, handle: SessionHandle, detail: JsonObject?, fresh: Boolean, chat: () -> Unit,
    sendAgain: () -> Unit, openRunner: (String) -> Unit) {
    detail ?: return
    val runner = detail.obj("assignedRunner")
    val card = SessionRunStart.card(detail, runner?.text("displayName")?.takeIf { it.isNotEmpty() } ?: runner?.text("name"), runner?.text("version"))
        ?: return
    val api = remember(handle) { TaskApi(app.session, handle) { app.canWrite(handle) } }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val taskId = detail.text("taskId")
    val runnerId = detail.text("assignedRunnerId") ?: runner?.text("id")
    var starting by remember(detail.text("id")) { mutableStateOf(false) }
    var said by remember(detail.text("id")) { mutableStateOf<String?>(null) }
    val warn = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).background(warn.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
        .padding(10.dp).testTag("session-run-start"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(16.dp), tint = warn)
            Text(SessionRunStart.title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold), color = warn)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(card.why, Modifier.testTag("session-run-start:why"), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
            Text(card.body, style = MaterialTheme.typography.bodySmall, color = secondary)
        }
        if (card.lines.isNotEmpty()) SelectionContainer {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                card.lines.forEach { Text(it, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            card.actions.forEach { action ->
                val enabled = when (action.kind) {
                    SessionRunStart.Kind.START_IT_AGAIN -> fresh && !starting && taskId != null
                    SessionRunStart.Kind.SEND_IT_AGAIN -> fresh
                    SessionRunStart.Kind.OPEN_RUNNER -> runnerId != null
                    SessionRunStart.Kind.CHAT_ABOUT_THIS -> true
                }
                val press = {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    when (action.kind) {
                        SessionRunStart.Kind.START_IT_AGAIN -> taskId?.let { task -> scope.launch {
                            starting = true; said = null
                            try {
                                api.execute(task, UUID.randomUUID().toString(), revision = "run-start:${detail.text("id")}")
                                said = SessionRunStart.startingAgain
                            } catch (cancel: CancellationException) { throw cancel }
                            catch (failure: Exception) { said = "Couldn't start it again — ${failureReason(failure)}." }
                            finally { starting = false; app.realtime.refreshSession() }
                        } }
                        SessionRunStart.Kind.SEND_IT_AGAIN -> sendAgain()
                        SessionRunStart.Kind.OPEN_RUNNER -> runnerId?.let(openRunner)
                        SessionRunStart.Kind.CHAT_ABOUT_THIS -> chat()
                    }
                    Unit
                }
                val tag = Modifier.heightIn(min = 48.dp).testTag("session-run-start:${action.kind.name}")
                if (action.primary) Button(onClick = press, tag, enabled = enabled) { Text(action.label) }
                else OutlinedButton(onClick = press, tag, enabled = enabled) { Text(action.label) }
            }
        }
        said?.let { line ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(line, Modifier.weight(1f).testTag("session-run-start:said"), style = MaterialTheme.typography.bodySmall,
                    color = if (line == SessionRunStart.startingAgain) secondary else warn)
                IconButton(onClick = { said = null }) { Icon(painterResource(R.drawable.ic_close), "Dismiss", Modifier.size(14.dp)) }
            }
        }
        card.footer?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
    }
}

/** What went wrong, in the words iOS's `APIClient.failureReason` uses. */
internal fun failureReason(error: Throwable): String = when {
    error is ApiError && error.status == 401 -> "you're signed out"
    error is ApiError -> error.messages.joinToString("\n").ifBlank { "the server returned ${error.status}" }
    error is NetworkException -> "the connection dropped"
    else -> error.message?.trimEnd('.') ?: "the server's reply couldn't be read"
}

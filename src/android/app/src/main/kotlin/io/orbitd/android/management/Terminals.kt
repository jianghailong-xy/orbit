package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.Terminal
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.core.cards.TerminalsApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.ZoneId

/**
 * The approve-terminal card and Settings → Terminals (docs/terminal-session-design.md, "The terminal credential") — OrbitKit
 * `Terminals` (web lib/terminals.ts), word for word. Its dates and clocks are Access tokens' own.
 */
internal object Terminals {
    // The approve card (board 2, marker 7).
    const val APPROVE_TITLE = "Approve a terminal?"
    const val APPROVE_DETAIL = "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it in Settings → Terminals."
    const val DENY = "Deny"
    const val APPROVE = "Approve"

    /** "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye. */
    fun requestLine(request: TerminalRequest) = "Terminal on ${request.machineName} · code ${request.userCode}"

    // Settings → Terminals.
    const val TITLE = "Terminals"
    const val HINT = "Terminals where you typed orbit and approved it. Each one can start sessions on its machine and answer their approval cards until it expires."
    const val EMPTY = "No terminals are signed in."
    const val REVOKE = "Revoke"
    const val REVOKE_DETAIL = "It stops working at once. Typing orbit there asks you to approve it again."
    const val REVOKED = "Terminal revoked"
    const val COULD_NOT_REVOKE = "Couldn't revoke the terminal"
    const val COULD_NOT_LOAD = "Couldn’t load your terminals:"
    const val NEVER_USED = "Never used"

    /** "Revoke the terminal on dev-laptop?" */
    fun revokeTitle(terminal: Terminal) = "Revoke the terminal on ${terminal.machineName}?"
    /** "Couldn't revoke the terminal: the connection dropped". */
    fun notRevoked(reason: String) = "$COULD_NOT_REVOKE: $reason"

    /** "Approved Nov 12, 2026" */
    fun approvedLine(terminal: Terminal, zone: ZoneId = ZoneId.systemDefault()) =
        "Approved ${AccessTokens.fullDate(terminal.approvedAt, zone) ?: terminal.approvedAt}"

    /** "Last used 3m ago", or "Never used". */
    fun lastUsedLine(terminal: Terminal, nowMs: Long): String {
        val lastUsedAt = terminal.lastUsedAt ?: return NEVER_USED
        return "Last used ${ShareCopy.ago(lastUsedAt, nowMs) ?: "unknown"}"
    }

    /** "Expires Dec 12, 2026 · in 30 days" */
    fun expiresLine(terminal: Terminal, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val day = AccessTokens.fullDate(terminal.expiresAt, zone) ?: terminal.expiresAt
        return AccessTokens.untilLine(terminal.expiresAt, nowMs)?.let { "Expires $day · $it" } ?: "Expires $day"
    }

    /** "2 signed in" — Settings' row value. */
    fun settingsValue(count: Int) = if (count > 0) "$count signed in" else "None"
}

/** TerminalsSettingsPage: every live terminal — its machine, when it was approved, last used and when it expires — each with Revoke,
 * which asks first. Revoked or not, the list is read again, so a revoked terminal leaves it. [changed] counts `terminals.changed`: each
 * one reads the list again too. */
@Composable
fun TerminalsSettings(api: ManagementApi, revision: Long, changed: Long = 0L) {
    val terminalsApi = remember(api) { TerminalsApi(api.session, api.handle) }
    val scope = rememberCoroutineScope()
    val notice = remember { Notice() }
    val now = rememberNow(60_000)
    var terminals by remember(api) { mutableStateOf<List<Terminal>?>(null) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<Terminal?>(null) }
    var revoking by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        try { terminals = terminalsApi.list(); failure = null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
    }
    fun revoke(terminal: Terminal) {
        revoking = terminal.id
        scope.launch {
            val reason = try { terminalsApi.revoke(terminal.id); null }
                catch (e: CancellationException) { throw e } catch (e: Exception) { personalFailure(e) }
            load()
            revoking = null
            notice.show(reason?.let(Terminals::notRevoked) ?: Terminals.REVOKED)
        }
    }
    LaunchedEffect(api, revision, changed, rememberResumed()) { load() }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(Terminals.HINT, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            val shown = terminals
            when {
                shown == null && failure != null -> {
                    Text("${Terminals.COULD_NOT_LOAD} $failure", color = Ink.muted)
                    TextButton(onClick = { scope.launch { load() } }) { Text("Retry") }
                }
                shown == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                else -> {
                    failure?.let { Text("${Terminals.COULD_NOT_LOAD} $it", color = Ink.red, style = MaterialTheme.typography.labelMedium) }
                    if (shown.isEmpty()) Text(Terminals.EMPTY, color = Ink.muted)
                    shown.forEach { terminal ->
                        HorizontalDivider()
                        TerminalRow(terminal, now, busy = revoking == terminal.id) { asking = terminal }
                    }
                }
            }
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    asking?.let { terminal ->
        AlertDialog(onDismissRequest = { asking = null }, title = { Text(Terminals.revokeTitle(terminal)) }, text = { Text(Terminals.REVOKE_DETAIL) },
            confirmButton = { TextButton(onClick = { asking = null; revoke(terminal) }) { Text(Terminals.REVOKE, color = Ink.red) } },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } })
    }
}

/** One terminal as the list shows it: its machine, and when it was approved, last used and expires. Never its credential. */
@Composable
private fun TerminalRow(terminal: Terminal, now: Long, busy: Boolean, revoke: () -> Unit) {
    Row(Modifier.fillMaxWidth().alpha(if (busy) .5f else 1f).testTag("terminal:${terminal.id}"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(terminal.machineName, maxLines = 2)
            listOf(Terminals.approvedLine(terminal), Terminals.lastUsedLine(terminal, now), Terminals.expiresLine(terminal, now)).forEach {
                Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            }
        }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = revoke, enabled = !busy, modifier = Modifier.testTag("terminal:${terminal.id}:revoke")) {
            Text(Terminals.REVOKE, color = Ink.red)
        }
    }
}

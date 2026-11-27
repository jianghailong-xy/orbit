package io.orbitd.android.management

import androidx.compose.foundation.layout.*
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
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

/**
 * The approve-terminal card and a machine page's Terminals (docs/terminal-session-design.md, "The terminal credential") — OrbitKit
 * `Terminals` (web lib/terminals.ts), word for word. Its dates and clocks are Access tokens' own.
 */
internal object Terminals {
    // The approve card (board 2, marker 7).
    const val APPROVE_TITLE = "Approve a terminal?"
    const val APPROVE_DETAIL = "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it on this machine's page in Settings."
    const val DENY = "Deny"
    const val APPROVE = "Approve"

    /** "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye. */
    fun requestLine(request: TerminalRequest) = "Terminal on ${request.machineName} · code ${request.userCode}"

    // A machine page's Terminals (docs/mocks/terminals-on-machine-page/01-board.html ②).
    const val TITLE = "Terminals"
    const val MACHINE_HINT = "Terminals on this machine where you typed orbit and approved it. Each one can start sessions here and answer their approval cards until it expires."
    const val REVOKE = "Revoke"
    const val REVOKE_DETAIL = "It stops working at once. Typing orbit there asks you to approve it again."
    const val REVOKED = "Terminal revoked"
    const val COULD_NOT_REVOKE = "Couldn't revoke the terminal"
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

    /** "Last used 3m ago · Expires Dec 12, 2026 · in 30 days": the row's second line (board ③). */
    fun usedAndExpiresLine(terminal: Terminal, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()) =
        "${lastUsedLine(terminal, nowMs)} · ${expiresLine(terminal, nowMs, zone)}"

    /** [runnerId]'s terminals, newest approval first (board ②). */
    fun on(terminals: List<Terminal>, runnerId: String): List<Terminal> = terminals
        .filter { ObjectId.same(it.runnerId, runnerId) }
        .sortedWith(compareByDescending<Terminal> { millis(it.approvedAt) ?: 0L }.thenByDescending { it.id })

    private fun millis(iso: String) = try { Instant.parse(iso).toEpochMilli() } catch (_: Exception) { null }
}

/** A machine page's Terminals (docs/mocks/terminals-on-machine-page/01-board.html ②③; web `MachineTerminalsSection`): this machine's
 * approved terminals, newest first, each with Revoke, which asks first. Nothing at all while it has none. The list is read when the page
 * is drawn or resumed, whenever [reread] changes (an approve card decided on the page, or `terminals.changed` reading the requests
 * again), every 15 s as the page reads its machine, and after a Revoke, so a revoked terminal leaves it. */
@Composable
internal fun MachineTerminals(api: ManagementApi, runnerId: String, notice: Notice, reread: Any?) {
    val terminalsApi = remember(api) { TerminalsApi(api.session, api.handle) }
    val scope = rememberCoroutineScope()
    val now = rememberNow(60_000)
    var terminals by remember(api, runnerId) { mutableStateOf<List<Terminal>>(emptyList()) }
    var asking by remember { mutableStateOf<Terminal?>(null) }
    var revoking by remember { mutableStateOf<String?>(null) }
    // A failed read keeps what was drawn; the next one tries again.
    suspend fun load() {
        try { terminals = Terminals.on(terminalsApi.list(), runnerId) }
        catch (e: CancellationException) { throw e } catch (_: Exception) { }
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
    val resumed = rememberResumed()
    LaunchedEffect(api, runnerId, reread, resumed) {
        if (!resumed) return@LaunchedEffect
        while (true) { load(); delay(15_000) }
    }
    if (terminals.isNotEmpty()) FormSection(Terminals.TITLE, footer = Terminals.MACHINE_HINT) {
        Column(Modifier.testTag("machine-terminals")) {
            terminals.forEachIndexed { index, terminal ->
                if (index > 0) HorizontalDivider()
                TerminalRow(terminal, now, busy = revoking == terminal.id) { asking = terminal }
            }
        }
    }
    asking?.let { terminal ->
        AlertDialog(onDismissRequest = { asking = null }, title = { Text(Terminals.revokeTitle(terminal)) }, text = { Text(Terminals.REVOKE_DETAIL) },
            confirmButton = { TextButton(onClick = { asking = null; revoke(terminal) }) { Text(Terminals.REVOKE, color = Ink.red) } },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } })
    }
}

/** One approved terminal as its machine's page shows it (board ③): when it was approved, then when it was last used and when it
 * expires on one line, and Revoke. No machine name: the page is the machine. Never its credential. */
@Composable
private fun TerminalRow(terminal: Terminal, now: Long, busy: Boolean, revoke: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).alpha(if (busy) .5f else 1f).testTag("terminal:${terminal.id}"),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(Terminals.approvedLine(terminal), maxLines = 2)
            Text(Terminals.usedAndExpiresLine(terminal, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = revoke, enabled = !busy, modifier = Modifier.testTag("terminal:${terminal.id}:revoke")) {
            Text(Terminals.REVOKE, color = Ink.red)
        }
    }
}

package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Settings → Access tokens: the personal access tokens this account has issued, filed by whether they still work — OrbitKit
 * AccessTokensList (web AccessTokensPage, AccessTokenTable and lib/accessTokens.ts), word for word. The app lists and revokes;
 * a token is issued on the web only (docs/personal-access-token-design.md §9), so the one thing only the apps say is where to
 * go for a new one. GET /access-tokens answers every column but the hash, so never the token itself.
 */
internal object AccessTokens {
    enum class Tab(val label: String, val empty: String) {
        ACTIVE("Active", "No active tokens. Create one to use the API or the orbit CLI as yourself."),
        ENDED("Revoked & expired", "No token has been revoked or has expired."),
    }

    const val TITLE = "Access tokens"
    const val SUBTITLE = "Let your scripts and the orbit CLI use the Orbit API as you, with only the access you give each token. Treat a token like a password."
    /** Where the web page has its New token button: the apps never issue one (§9). */
    const val ISSUED_ON_THE_WEB = "New tokens are created in Settings → Access tokens on the web."
    const val COULD_NOT_LOAD = "Couldn’t load your tokens:"
    // Revoking asks first: anything using the token stops working at once.
    const val REVOKE = "Revoke"
    const val REVOKE_DETAIL = "Anything using it stops working at once. This can’t be undone."
    const val REVOKED = "Token revoked"
    const val COULD_NOT_REVOKE = "Couldn't revoke the token"
    /** The mark a token that never expires carries in the list (§9, §11.1). */
    const val NEVER_EXPIRES = "Never expires"
    const val NEVER_USED = "Never used"
    const val ADDRESS_UNKNOWN = "Address unknown"

    fun revokeTitle(token: JsonObject) = "Revoke “${token.text("name")}”?"
    /** "Couldn't revoke the token: the connection dropped". */
    fun notRevoked(reason: String) = "$COULD_NOT_REVOKE: $reason"

    /** ACTIVE works; EXPIRED, REVOKED — and a state this build does not know — no longer do. */
    fun isActive(token: JsonObject) = token.text("state") == "ACTIVE"
    /** The tokens in one tab, newest first as the server answered them. */
    fun tokens(all: List<JsonObject>, tab: Tab) = all.filter { isActive(it) == (tab == Tab.ACTIVE) }
    /** Only a token that still works has anything left to revoke. */
    fun canRevoke(token: JsonObject) = isActive(token)
    /** "orbit_pat_…k3Fq" — enough of the token to tell it from the others. Orbit never has more. */
    fun hint(token: JsonObject) = "orbit_pat_…${token.text("tokenHint")}"

    // What it can reach: the server's PAT_SCOPES (§4), in the order the web lists them (SCOPE_GROUPS).
    private class ScopeGroup(val resource: String, val read: String, val write: String?)
    private val scopeGroups = listOf(ScopeGroup("Tasks", "tasks:read", "tasks:write"), ScopeGroup("Projects", "projects:read", "projects:write"),
        ScopeGroup("Sessions", "sessions:read", "sessions:write"), ScopeGroup("Workspaces", "workspaces:read", "workspaces:write"),
        ScopeGroup("Runners", "runners:read", null), ScopeGroup("Wiki", "wiki:read", "wiki:write"), ScopeGroup("Events", "events:read", null))
    /** The read-only preset, and every scope there is: the server's twelve PAT_SCOPES. */
    val readScopes = scopeGroups.map { it.read }
    val allScopes = scopeGroups.flatMap { listOfNotNull(it.read, it.write) }

    /** A token's scopes in a few words: a preset's name, or what it can do resource by resource — "Read-only · everything",
     * "Tasks: read & write · Sessions: read". Scopes newer than this build are still what the token holds: named, not dropped. */
    fun scopeSummary(scopes: List<String>): String {
        if (sameSet(scopes, allScopes)) return "Read & write · everything"
        if (sameSet(scopes, readScopes)) return "Read-only · everything"
        val parts = scopeGroups.mapNotNull { group ->
            val read = group.read in scopes
            val write = group.write?.let { it in scopes } ?: false
            when {
                read && write -> "${group.resource}: read & write"
                read -> "${group.resource}: read"
                write -> "${group.resource}: write"
                else -> null
            }
        }
        return if (parts.isEmpty()) scopes.joinToString(", ") else parts.joinToString(" · ")
    }

    /** Which workspaces it reaches: all of them, or those it is confined to — a workspace deleted since is counted, since its
     * name is gone. */
    fun workspacesLine(token: JsonObject): String {
        val ids = token.strings("workspaceIds")
        if (ids.isEmpty()) return "All workspaces"
        val named = token.list("workspaces")
        val gone = ids.size - named.size
        val names = named.map { it.text("name") } + if (gone > 0) listOf(if (gone == 1) "a deleted workspace" else "$gone deleted workspaces") else emptyList()
        return names.joinToString(", ")
    }

    /** What it can do, and where when it is confined: "Read-only · everything", "Tasks: read & write · in orbit, docs". */
    fun accessLine(token: JsonObject): String {
        val summary = scopeSummary(token.strings("scopes"))
        return if (token.strings("workspaceIds").isEmpty()) summary else "$summary · in ${workspacesLine(token)}"
    }

    /** A working token with no expiry: the list marks it, since a leak of it lasts until revoked. */
    fun isNeverExpiring(token: JsonObject) = isActive(token) && token.str("expiresAt") == null

    /** Where it stands on its clock: "Expires Jan 4, 2027 · in 90 days" while it works, "Never expires" for one that never
     * will, and why one that stopped did ("Revoked Oct 6, 2026"). */
    fun expiryLine(token: JsonObject, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (!isActive(token)) return endedLine(token, zone)
        val expiresAt = token.str("expiresAt") ?: return NEVER_EXPIRES
        val day = fullDate(expiresAt, zone) ?: expiresAt
        return untilLine(expiresAt, nowMs)?.let { "Expires $day · $it" } ?: "Expires $day"
    }

    /** Why a token that no longer works stopped, in the list's words. */
    fun endedLine(token: JsonObject, zone: ZoneId = ZoneId.systemDefault()): String {
        if (token.text("state") == "EXPIRED") {
            val day = (token.str("expiresAt") ?: token.str("revokedAt"))?.let { fullDate(it, zone) } ?: return "Expired"
            return "Expired $day"
        }
        val at = token.str("revokedAt")?.let { fullDate(it, zone) }?.let { " $it" }.orEmpty()
        return when (token.str("revokedReason")) {
            "ADMIN" -> "Revoked by an administrator$at"
            "PASSWORD_CHANGED" -> "Revoked with a password change$at"
            else -> "Revoked$at"
        }
    }

    /** How far off an expiry still ahead is: "in 89 days", "in 5 hours", "in less than an hour" (halves away from zero, as
     * Swift rounds). */
    fun untilLine(iso: String, nowMs: Long): String? {
        val at = isoMs(iso) ?: return null
        val hours = Math.round((at - nowMs) / 3_600_000.0)
        if (hours < 1) return "in less than an hour"
        if (hours < 24) return if (hours == 1L) "in 1 hour" else "in $hours hours"
        val days = Math.round(hours / 24.0)
        return if (days == 1L) "in 1 day" else "in $days days"
    }

    /** "Last used 3h 20m ago · 203.0.113.7", or "Never used" — the place a lost device's token gives itself away. */
    fun lastUsedLine(token: JsonObject, nowMs: Long): String {
        val lastUsedAt = token.str("lastUsedAt") ?: return NEVER_USED
        return "Last used ${ShareCopy.ago(lastUsedAt, nowMs) ?: "unknown"} · ${token.str("lastUsedIp") ?: ADDRESS_UNKNOWN}"
    }

    /** "Oct 6, 2026", the way the web list names a day. */
    fun fullDate(iso: String, zone: ZoneId = ZoneId.systemDefault()): String? =
        isoMs(iso)?.let { DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US).withZone(zone).format(Instant.ofEpochMilli(it)) }

    private fun sameSet(scopes: List<String>, of: List<String>) = scopes.size == of.size && of.all { it in scopes }
}

/** GET /access-tokens: every token the account has issued, newest first. A malformed answer is no list — never "No active tokens". */
internal fun accessTokenList(value: JsonElement): List<JsonObject> {
    val read = value as? JsonObject ?: throw IllegalStateException("Invalid access-token response")
    val tokens = read["tokens"] as? JsonArray ?: throw IllegalStateException("Missing access-token list")
    return tokens.map { token -> (token as? JsonObject)?.takeIf { it.text("id").isNotBlank() } ?: throw IllegalStateException("Invalid access token") }
}

/** AccessTokensSettingsPage: every personal access token this account has issued, by whether it still works — the web page's tabs,
 * lines and words. A working token is revoked from its ⋯ menu (iOS's swipe), which asks first; anything using it stops working at
 * once. A new token is issued on the web only, which the page says. */
@Composable
fun AccessTokensSettings(api: ManagementApi, revision: Long) {
    val scope = rememberCoroutineScope()
    val notice = remember { Notice() }
    val now = rememberNow(60_000)
    var tokens by remember(api) { mutableStateOf<List<JsonObject>?>(null) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf(AccessTokens.Tab.ACTIVE) }
    var asking by remember { mutableStateOf<JsonObject?>(null) }
    var revoking by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        try { tokens = accessTokenList(api.get("access-tokens")); failure = null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
    }
    // Revoked or not, the list is read again, so it shows what the server has.
    fun revoke(token: JsonObject) {
        revoking = token.text("id")
        scope.launch {
            val reason = try { api.delete("access-tokens/${token.text("id")}"); null }
                catch (e: CancellationException) { throw e } catch (e: Exception) { personalFailure(e) }
            load()
            revoking = null
            notice.show(reason?.let(AccessTokens::notRevoked) ?: AccessTokens.REVOKED)
        }
    }
    LaunchedEffect(api, revision, rememberResumed()) { load() }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val all = tokens.orEmpty()
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                AccessTokens.Tab.entries.forEachIndexed { index, each ->
                    SegmentedButton(selected = tab == each, onClick = { tab = each }, shape = SegmentedButtonDefaults.itemShape(index, AccessTokens.Tab.entries.size)) {
                        Text("${each.label} ${AccessTokens.tokens(all, each).size}")
                    }
                }
            }
            Text("${AccessTokens.SUBTITLE} ${AccessTokens.ISSUED_ON_THE_WEB}", style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            when {
                tokens == null && failure != null -> {
                    Text("${AccessTokens.COULD_NOT_LOAD} $failure", color = Ink.muted)
                    TextButton(onClick = { scope.launch { load() } }) { Text("Retry") }
                }
                tokens == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                else -> {
                    failure?.let { Text("${AccessTokens.COULD_NOT_LOAD} $it", color = Ink.red, style = MaterialTheme.typography.labelMedium) }
                    val shown = AccessTokens.tokens(all, tab)
                    if (shown.isEmpty()) Text(tab.empty, color = Ink.muted)
                    shown.forEach { token ->
                        HorizontalDivider()
                        AccessTokenRow(token, now, busy = revoking == token.text("id"),
                            revoke = if (AccessTokens.canRevoke(token)) { { asking = token } } else null)
                    }
                }
            }
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    // On a phone a confirmation is a dialog with Cancel beside its press, as every other one (A13-15).
    asking?.let { token ->
        AlertDialog(onDismissRequest = { asking = null }, title = { Text(AccessTokens.revokeTitle(token)) }, text = { Text(AccessTokens.REVOKE_DETAIL) },
            confirmButton = { TextButton(onClick = { asking = null; revoke(token) }) { Text(AccessTokens.REVOKE, color = Ink.red) } },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } })
    }
}

/** One token as the list shows it (AccessTokenRow): its name and the end of the token, what it can reach, when it stops working —
 * one that never does is marked — and when and from where it was last used. Never the token itself: Orbit does not keep it. */
@Composable
private fun AccessTokenRow(token: JsonObject, now: Long, busy: Boolean, revoke: (() -> Unit)?) {
    var menu by remember { mutableStateOf(false) }
    val name = token.text("name")
    Row(Modifier.fillMaxWidth().alpha(if (busy) .5f else 1f), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, Modifier.weight(1f), maxLines = 2)
                Spacer(Modifier.width(8.dp))
                Text(AccessTokens.hint(token), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = Ink.muted, maxLines = 1)
            }
            Text(AccessTokens.accessLine(token), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            if (AccessTokens.isNeverExpiring(token)) Text(AccessTokens.NEVER_EXPIRES,
                Modifier.background(Ink.amber.copy(alpha = .14f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = Ink.amber)
            else Text(AccessTokens.expiryLine(token, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            Text(AccessTokens.lastUsedLine(token, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
        if (revoke != null) Box {
            TextButton(onClick = { menu = true }, enabled = !busy) { Text("⋯", Modifier.clearAndSetSemantics { contentDescription = "More for $name" }) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(AccessTokens.REVOKE, color = Ink.red) }, onClick = { menu = false; revoke() })
            }
        }
    }
}

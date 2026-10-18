package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.CursorRuntime
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlin.math.ceil

/**
 * Cursor CLI on the management pages, as the owner's board draws it for a phone (docs/mocks/cursor-engine, iOS 2–4): its words — the
 * web's (P7a) wherever it has the same thing to say — and what a machine's page and a key's page read off the runner and the key.
 */
internal object CursorCopy {
    /** The engine page's footer (iOS 2 ③): the build Orbit pins, and whose plan a session spends. */
    val ENGINE_FOOTER get() = "Orbit keeps ${CursorRuntime.CLI} on the version it pins, ${CursorRuntime.PINNED_VERSION}. Sign-ins live on this " +
        "machine — a session spends that account’s Cursor plan."
    /** A machine's Engines footer once it draws Cursor CLI's row (iOS 2 ②): every CLI there is kept current but the one Orbit pins. */
    val ENGINES_FOOTER get() = "Orbit keeps these CLIs updated every 30 min — ${CursorRuntime.CLI} stays on the version Orbit pins. Sign-ins " +
        "live on this machine — a session spends that subscription, nothing to paste."
    /** An account's plan, as Cursor names it: "Free plan". */
    fun plan(name: String) = "$name plan"
    /** A signed-in account Cursor reports no usage for, or only 0%, which is no reading (contract §11): never a 0% drawn. */
    const val USAGE_UNAVAILABLE = "Usage unavailable"
    /** Why there is no number (web's title on the same words). */
    fun usageUnavailable(plan: String?) =
        "Cursor doesn’t report how much of ${plan?.let { "the $it plan’s" } ?: "this account’s"} usage is left, so Orbit shows no number rather than 0%."
    /** An account a turn met Cursor's usage limit on this period: until when, when Cursor said (web statusOf). */
    fun spent(resets: String?) = if (resets == null) "Spent" else "Spent · resets $resets"
    /** A build other than the pinned one is put back the way a missing one is put there (iOS 2: the engine page's press). */
    val REINSTALL get() = "Reinstall ${CursorRuntime.CLI}"

    // The sign-in link (iOS 3; web RunnerSignIn's Cursor card)

    /** Cursor's page, in bold inside the lead. */
    const val SITE = "cursor.com"
    /** The lead over the link: whose account to sign in with there, around [SITE]. */
    fun signInLead(adding: Boolean, again: Boolean) = when {
        adding -> "Sign in on $SITE with the account you are adding:"
        again -> "Sign in on $SITE with this account again:"
        else -> "Sign in on $SITE with the account this runner should use:"
    }
    const val OPEN_SITE = "Open $SITE"
    const val COPY_LINK = "Copy Sign-In Link"
    const val LINK_COPIED = "Sign-In Link Copied"
    const val WAITING = "Waiting for you to sign in…"
    /** " · link expires in 26 min" — counted down a minute at a time — or that it has. */
    fun expiry(minutesLeft: Int) = if (minutesLeft > 0) "link expires in $minutesLeft min" else "the link has expired"
    /** A new run of `agent login` hands a new link: what ran out or failed was the link. */
    const val GET_A_NEW_LINK = "Get a New Link"
    /** Where the runner can't sign Cursor CLI in (no cursor-account-login/v1): the server's own refusal (CURSOR_LOGIN_TOO_OLD). */
    val SIGN_IN_TOO_OLD get() = "This runner is too old to sign in to ${CursorRuntime.CLI} — update it, then try again."

    // A Cursor User API Key's page (iOS 4)

    /** Under Cursor CLI in Works with: what a session on the key spends. */
    const val BILLED = "Billed to this key’s Cursor plan"
    val WORKS_WITH_FOOTER get() = "Pick it for a ${CursorRuntime.CLI} session in the composer’s model menu → Provider. It runs no other engine."
    const val CHECK = "Check"
    const val LAST_CHECK = "Last check"
    const val VALID = "Valid"
    const val REJECTED = "Rejected"
    const val COULDNT_CHECK = "Couldn’t check"
    const val NOT_CHECKED = "Not checked yet"
    const val CHECK_AGAIN = "Check Again"
    const val CHECKING = "Checking…"
    val CHECK_FOOTER get() = "A runner with ${CursorRuntime.CLI} checks the key with Cursor (no request is spent)."
    const val REJECTED_FOOTER = "Cursor said “The provided API key is invalid.” Paste a new key on the web, then check again."
    /** The server's own words for a check that never reached Cursor (UNREACHABLE): the network, never the key. */
    const val UNREACHABLE_FOOTER = "Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine."
    /** A Cursor key's protocol (web `runtimeSummary`). */
    const val PROTOCOL = "Cursor API"

    /** A Cursor User API Key among the account's own keys: its row's runtime is Cursor's dialect. */
    fun isKey(key: JsonObject) = key.str("runtime") == ProviderEngines.CURSOR

    /** The value Last check says: what Cursor answered the key's last check, and how long ago — "Valid · 4m ago". */
    fun lastCheck(key: JsonObject, nowMs: Long): String {
        val state = when (key.str("keyCheckState")) {
            "VALID" -> VALID; "INVALID" -> REJECTED; "UNREACHABLE" -> COULDNT_CHECK; else -> return NOT_CHECKED
        }
        return key.str("keyCheckedAt")?.let { "$state · ${DeepSeekBalance.ago(it, nowMs)}" } ?: state
    }

    /** The footer under Check: what the last answer means and what to do about it. */
    fun checkFooter(key: JsonObject) = when (key.str("keyCheckState")) {
        "INVALID" -> REJECTED_FOOTER; "UNREACHABLE" -> UNREACHABLE_FOOTER; else -> CHECK_FOOTER
    }

    /** What a Cursor key's row in API keys says at its end (iOS 4 ②): Rejected, where the Unavailable of a DeepSeek balance goes. */
    fun rowValue(key: JsonObject): PoolStatus? = if (key.str("keyCheckState") == "INVALID") PoolStatus(REJECTED, "warning") else null
}

/**
 * Cursor CLI's sign-in link (iOS 3 ②③; web RunnerSignIn): `agent login` prints one link and waits on it (contract §9), and nothing comes
 * back through here — the runner sees the sign-in finish — so the card offers the link, on this phone or another device, says how long it
 * lasts, and waits.
 */
@Composable
internal fun CursorSignInLink(url: String, expiresAt: String?, adding: Boolean, again: Boolean, busy: Boolean, cancel: () -> Unit) {
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    var copied by remember(url) { mutableStateOf(false) }
    // The link stops working about 23 minutes after the runner relays it: counted down a minute at a time.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(url) { while (true) { now = System.currentTimeMillis(); delay(30_000) } }
    val left = isoMs(expiresAt)?.let { ceil((it - now) / 60_000.0).toInt() }
    val lead = CursorCopy.signInLead(adding, again)
    Column(Modifier.testTag("cursor-sign-in-link"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(buildAnnotatedString {
            val at = lead.indexOf(CursorCopy.SITE)
            append(lead.substring(0, at))
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(CursorCopy.SITE) }
            append(lead.substring(at + CursorCopy.SITE.length))
        }, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { runCatching { uri.openUri(url) } }) { Text(CursorCopy.OPEN_SITE) }
            OutlinedButton(onClick = { copyText(context, "Sign-in link", url); copied = true }) {
                Text(if (copied) CursorCopy.LINK_COPIED else CursorCopy.COPY_LINK)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(CursorCopy.WAITING + (left?.let { " · " + CursorCopy.expiry(it) } ?: ""), style = MaterialTheme.typography.labelMedium)
        }
        TextButton(onClick = cancel, enabled = !busy) { Text(AccountCopy.CANCEL) }
    }
}

/**
 * A Cursor User API Key's page, read-only (iOS 4 ③④⑤): what it runs on — Cursor CLI alone, billed to the key's own Cursor plan — what
 * Cursor answered its last check, with Check Again where that was no yes, and the key itself. Adding or changing a key happens on the web.
 */
@Composable
internal fun CursorKeyPage(api: ManagementApi, revision: Long, providerId: String) {
    val scope = rememberCoroutineScope()
    val now = rememberNow(30_000)
    var key by remember(providerId) { mutableStateOf<JsonObject?>(null) }
    var gone by remember(providerId) { mutableStateOf(false) }
    var failure by remember(providerId) { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    // What the last Check Again answered when its answer was not kept on the key (no runner could ask), in the server's words.
    var answer by remember(providerId) { mutableStateOf<String?>(null) }
    suspend fun load() {
        try {
            val found = providerObjects(api.get("providers/mine")).firstOrNull { ObjectId.same(it.text("id"), providerId) && CursorCopy.isKey(it) }
            key = found; gone = found == null; failure = null
            found?.let { rememberProviderKeyTitle(providerId, it.str("label") ?: it.text("slug")) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
    }
    LaunchedEffect(providerId, revision, rememberResumed()) { load() }
    fun checkAgain() {
        if (checking) return
        checking = true; answer = null
        scope.launch {
            try {
                val reply = api.post("providers/mine/$providerId/key-check") as? JsonObject
                if (reply?.bool("recorded") != true) answer = reply?.str("message")
            } catch (e: CancellationException) { throw e } catch (e: Exception) { answer = personalFailure(e) }
            load()
            checking = false
        }
    }
    val provider = key
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        when {
            gone -> { Text(DeepSeekBalance.KEY_GONE, Modifier.padding(24.dp), color = Ink.muted); return@Column }
            provider == null -> { Text(failure ?: "Loading…", Modifier.padding(24.dp), color = if (failure != null) Ink.red else Ink.muted); return@Column }
        }
        FormSection(DeepSeekBalance.WORKS_WITH, footer = CursorCopy.WORKS_WITH_FOOTER) {
            Column(Modifier.padding(vertical = 8.dp)) {
                Text(CursorRuntime.CLI)
                Text(CursorCopy.BILLED, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            }
        }
        val state = provider.str("keyCheckState")
        FormSection(CursorCopy.CHECK, footerContent = {
            Text(CursorCopy.checkFooter(provider), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            answer?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.amber) }
        }) {
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp).testTag("cursor-key-last-check")) {
                Text(CursorCopy.LAST_CHECK, Modifier.weight(1f))
                Text(CursorCopy.lastCheck(provider, now), color = if (state == "INVALID") Ink.amber else Ink.muted,
                    fontWeight = if (state == "INVALID") FontWeight.SemiBold else null)
            }
            if (state != "VALID") {
                HorizontalDivider()
                TextButton(onClick = ::checkAgain, enabled = !checking, modifier = Modifier.testTag("cursor-key-check-again")) {
                    Text(if (checking) CursorCopy.CHECKING else CursorCopy.CHECK_AGAIN)
                }
            }
        }
        FormSection(KeyEngines.KEY, footer = KeyEngines.footer(listOf(CursorRuntime.CLI))) {
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { Text(KeyEngines.PROTOCOL, Modifier.weight(1f)); Text(CursorCopy.PROTOCOL, color = Ink.muted) }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { Text(DeepSeekBalance.DEFAULT_MODEL, Modifier.weight(1f)); Text(CursorRuntime.AUTO, color = Ink.muted) }
            DeepSeekBalance.endpointHost(provider)?.let { host ->
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { Text(DeepSeekBalance.ENDPOINT, Modifier.weight(1f)); Text(host, color = Ink.muted) }
            }
        }
        Spacer(Modifier.height(48.dp))
    }
}

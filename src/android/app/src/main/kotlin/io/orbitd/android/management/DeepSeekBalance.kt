package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.net.URI
import java.util.Locale

/**
 * The DeepSeek account balance behind one of the account's own DeepSeek keys, as Settings → Providers and the key's page draw it —
 * OrbitKit DeepSeekBalance (web DeepSeekBalance.tsx and lib/deepseekBalance.ts). The server asks DeepSeek with the stored key, which
 * never reaches this client, and answers with the balance of the whole account, not what Orbit or a session spent.
 *
 * Every amount drawn is DeepSeek's own answer. Until there is one the state is [State.Loading], and a read that failed is
 * [State.Failed] with why — never a 0 standing in for a number.
 */
internal object DeepSeekBalance {
    const val TITLE = "DeepSeek account balance"
    const val TOP_UP = "Top up on DeepSeek"
    /** Where DeepSeek takes a top-up. Orbit can't top up for anyone; it only opens the page. */
    const val TOP_UP_URL = "https://platform.deepseek.com/top_up"
    const val TOTAL = "Total"
    const val GRANTED = "Granted"
    const val TOPPED_UP = "Topped up"
    const val REFRESH = "Refresh"
    const val RETRY = "Retry"
    const val UPDATED = "Updated"
    const val LAST_TRIED = "Last tried"
    const val BALANCE = "Balance"
    const val UNKNOWN = "Unknown"
    const val CHECKING = "Checking balance…"
    /** A DeepSeek key's row on Settings → Providers when there is no balance to put at its end. */
    const val UNAVAILABLE = "Unavailable"
    const val FAILED_TITLE = "Couldn't get the balance"
    const val LOW_TITLE = "Balance too low — DeepSeek calls will fail"
    const val LOW_DETAIL = "Every session using a key on this account will fail at its next request. Orbit can't top up for you."
    const val MULTI_CURRENCY = "Each currency is a separate balance; DeepSeek doesn't convert between them."
    /** The web's note, in the fewer words a phone's footnote has room for. */
    const val NOTE = "The balance of the whole DeepSeek account this key belongs to — everything using that account draws on it, so it isn't what Orbit or a session spent. Granted credit is spent first."
    /** iOS says "in Safari"; on Android the page opens in the device's browser (the coordinator's decision on A13-16). */
    const val OPENS_IN_BROWSER = "Opens platform.deepseek.com/top_up in your browser."
    const val NO_AMOUNT_YET = "No amount is shown until DeepSeek answers."
    /** What to do about a rejected key from a phone, which can't change one. */
    const val CHANGE_KEY_ON_WEB = "Change the key on the web, then retry."
    const val DEFAULT_MODEL = "Default model"
    const val ENDPOINT = "Endpoint"
    /** ProvidersOverview's: the key page's footer, and the page when the key has gone. */
    const val EDIT_ON_WEB = "Adding or changing a key happens on the web."
    const val KEY_GONE = "That provider no longer exists."

    private val presets = setOf("deepseek", "deepseek-harness")

    /** Whether one of the account's own providers (GET providers/mine) has a DeepSeek account balance: a stored key of
     * DeepSeek's — one of its two presets, or a custom endpoint on DeepSeek's own host. The server applies the same test. */
    fun applies(provider: JsonObject): Boolean {
        if (provider.bool("hasApiKey") != true) return false
        provider.str("presetSlug")?.let { return it in presets }
        val host = provider.str("baseUrl")?.let { runCatching { URI(it).host }.getOrNull() } ?: return false
        return host.lowercase(Locale.ROOT) == "api.deepseek.com"
    }

    /** The account's own DeepSeek key a row of Settings → Providers stands for. The key list is the pickers' catalogue (GET
     * providers), which carries no id or endpoint, so the row is matched by slug among the account's own providers. */
    fun key(row: JsonObject, mine: List<JsonObject>): JsonObject? =
        mine.firstOrNull { it.str("slug") == row.str("slug") && !it.str("id").isNullOrEmpty() && applies(it) }

    /** What asking for a balance came to: the server's answer, or — when the request never got one — why, in words. */
    sealed interface Reading {
        data class Answered(val balance: JsonObject) : Reading
        data class Unreachable(val why: String) : Reading
    }

    enum class Failure { KEY_REJECTED, NETWORK, UPSTREAM, UNREACHABLE }

    sealed interface State {
        data object Loading : State
        /** DeepSeek's balance, one entry per currency; [low] when DeepSeek says the account can't pay for more requests. */
        data class Read(val balances: List<JsonObject>, val low: Boolean, val fetchedAt: String, val sharedWith: List<JsonObject>) : State
        /** No balance: why, in the server's sentence or the request's, and when it was tried. */
        data class Failed(val failure: Failure, val message: String, val triedAt: String?) : State
    }

    fun state(reading: Reading?): State = when (reading) {
        null -> State.Loading
        is Reading.Unreachable -> State.Failed(Failure.UNREACHABLE, reading.why, null)
        is Reading.Answered -> {
            val answer = reading.balance
            if (answer.bool("ok") == true) {
                // A read with no currency in it is no balance at all — never an empty, or zero, one.
                val balances = answer.list("balances")
                val available = answer.bool("isAvailable")
                if (balances.isEmpty() || available == null) State.Failed(Failure.UPSTREAM, FAILED_TITLE, answer.str("fetchedAt"))
                else State.Read(balances, !available, answer.text("fetchedAt"), answer.list("sharedWith"))
            } else State.Failed(when (answer.str("reason")) {
                "KEY_REJECTED" -> Failure.KEY_REJECTED
                "NETWORK" -> Failure.NETWORK
                else -> Failure.UPSTREAM
            }, answer.str("message") ?: FAILED_TITLE, answer.str("fetchedAt"))
        }
    }

    /** What a failure says: the server's sentence, then — for a rejected key — what to do about it from here. */
    fun detail(failure: Failure, message: String) = if (failure == Failure.KEY_REJECTED) "$message $CHANGE_KEY_ON_WEB" else message

    /** What a DeepSeek key's row says at its end: the total — every currency, red once the account can't pay — or Unavailable,
     * orange, when there is no balance to show. Nothing while it loads. */
    fun rowValue(state: State): PoolStatus? = when (state) {
        State.Loading -> null
        is State.Read -> PoolStatus(state.balances.joinToString(" · ") { amount(it.text("totalBalance"), it.text("currency")) },
            if (state.low) "danger" else "neutral")
        is State.Failed -> PoolStatus(UNAVAILABLE, "warning")
    }

    /** The footnote's line about the other providers holding the same key, in three parts so their names can be set in bold. */
    fun sameAccount(siblings: List<JsonObject>): Triple<String, String, String>? {
        val last = siblings.lastOrNull() ?: return null
        val names = if (siblings.size == 1) last.text("label") else siblings.dropLast(1).joinToString(", ") { it.text("label") } + " and " + last.text("label")
        return Triple("Same DeepSeek account as ", names, if (siblings.size == 1) " — both show this balance." else " — all show this balance.")
    }

    /** An amount as DeepSeek wrote it, with two decimals and its currency's sign: "¥110.00", "$5.00", "¥12,345.60", or "12.30 EUR". */
    fun amount(value: String, currency: String): String {
        val text = value.toDoubleOrNull()?.let(::twoDecimals) ?: value
        return when (currency) { "CNY" -> "¥$text"; "USD" -> "$$text"; else -> "$text $currency" }
    }

    private fun twoDecimals(number: Double): String {
        val fixed = String.format(Locale.ROOT, "%.2f", Math.abs(number))
        val whole = fixed.substringBefore('.')
        val grouped = whole.reversed().chunked(3).joinToString(",").reversed()
        return (if (number < 0) "-" else "") + grouped + "." + fixed.substringAfter('.', "00")
    }

    /** One currency's granted and topped-up shares of its bar, each 0…1; null when they add up to nothing to split. */
    data class Split(val granted: Double, val toppedUp: Double)

    fun split(amount: JsonObject): Split? {
        val granted = amount.text("grantedBalance").toDoubleOrNull() ?: return null
        val toppedUp = amount.text("toppedUpBalance").toDoubleOrNull() ?: return null
        if (granted < 0 || toppedUp < 0 || granted + toppedUp <= 0) return null
        return Split(granted / (granted + toppedUp), toppedUp / (granted + toppedUp))
    }

    /** "Just now", "2 min ago", "3 h ago", "2 d ago": when the server last asked DeepSeek. */
    fun ago(iso: String, nowMs: Long): String {
        val at = isoMs(iso) ?: return UNKNOWN
        val minutes = (nowMs - at) / 60_000
        if (minutes < 1) return "Just now"
        if (minutes < 60) return "$minutes min ago"
        val hours = minutes / 60
        return if (hours < 24) "$hours h ago" else "${hours / 24} d ago"
    }

    /** The host a key's endpoint is on — `api.deepseek.com` — which is all of it a phone's row has room for. */
    fun endpointHost(provider: JsonObject): String? = provider.str("baseUrl")?.let { runCatching { URI(it).host }.getOrNull() }
}

/** ProvidersOverview.keyLine: the line under a key's name — its default model, by the name its model list gives it. Where the key
 * runs is the line under it (KeyEngines.line): a key runs on every engine its protocol allows, never on one of them. */
internal fun providerKeyLine(key: JsonObject): String? = key.str("defaultModel")?.takeIf { it.isNotEmpty() }?.let { model ->
    key.list("models").firstOrNull { it.str("value") == model }?.str("label")?.takeIf { it.isNotEmpty() } ?: model
}

/** Each DeepSeek key's balance among [mine], read side by side and handed to [each] as it comes, so a slow key holds up no other
 * (iOS 96e1a1536). */
internal suspend fun readDeepSeekBalances(api: ManagementApi, mine: List<JsonObject>, each: (String, DeepSeekBalance.Reading) -> Unit) = coroutineScope {
    mine.filter(DeepSeekBalance::applies).mapNotNull { it.str("id") }.forEach { id -> launch { each(id, readDeepSeekBalance(api, id, refresh = false)) } }
}

/** One key's balance: the server's last read of it, or — with [refresh] — DeepSeek asked again (at most once per 10 s for a key). */
internal suspend fun readDeepSeekBalance(api: ManagementApi, id: String, refresh: Boolean): DeepSeekBalance.Reading = try {
    val answer = api.get("providers/mine/$id/balance", if (refresh) listOf("refresh" to "1") else emptyList())
    DeepSeekBalance.Reading.Answered(answer as? JsonObject ?: throw IllegalStateException("Invalid balance response"))
} catch (e: CancellationException) { throw e } catch (e: Exception) { DeepSeekBalance.Reading.Unreachable(personalFailure(e)) }

/** The labels the key pages have read, so the shell's title is the key's name, as iOS titles the page. */
private val keyNames = mutableStateMapOf<String, String>()

internal fun providerKeyTitle(id: String): String? = keyNames[ObjectId.canonical(id) ?: id]

/** A DeepSeek key's page, read-only: the whole DeepSeek account's balance first, then where the key runs. Changing the key happens on
 * the web. */
@Composable
internal fun DeepSeekKeyPage(api: ManagementApi, revision: Long, providerId: String) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val now = rememberNow(60_000)
    var key by remember(providerId) { mutableStateOf<JsonObject?>(null) }
    var gone by remember(providerId) { mutableStateOf(false) }
    var failure by remember(providerId) { mutableStateOf<String?>(null) }
    var reading by remember(providerId) { mutableStateOf<DeepSeekBalance.Reading?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(providerId, revision, rememberResumed()) {
        try {
            val found = providerObjects(api.get("providers/mine")).firstOrNull { ObjectId.same(it.text("id"), providerId) && DeepSeekBalance.applies(it) }
            key = found; gone = found == null; failure = null
            found?.let { keyNames[ObjectId.canonical(providerId) ?: providerId] = it.str("label") ?: it.text("slug") }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e); return@LaunchedEffect }
        if (key != null) reading = readDeepSeekBalance(api, providerId, refresh = false)
    }
    fun refresh() {
        if (refreshing) return
        refreshing = true
        scope.launch { reading = readDeepSeekBalance(api, providerId, refresh = true); refreshing = false }
    }
    val provider = key
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        when {
            gone -> { Text(DeepSeekBalance.KEY_GONE, Modifier.padding(24.dp), color = Ink.muted); return@Column }
            provider == null -> { Text(failure ?: "Loading…", Modifier.padding(24.dp), color = if (failure != null) Ink.red else Ink.muted); return@Column }
        }
        val state = DeepSeekBalance.state(reading)
        FormSection(DeepSeekBalance.TITLE, footerContent = { BalanceFooter(state) }) {
            when (state) {
                DeepSeekBalance.State.Loading -> Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text(DeepSeekBalance.CHECKING, color = Ink.muted)
                }
                is DeepSeekBalance.State.Read -> {
                    if (state.low) BalanceAlert(Ink.red, DeepSeekBalance.LOW_TITLE, DeepSeekBalance.LOW_DETAIL)
                    state.balances.forEachIndexed { index, amount ->
                        if (index > 0 || state.low) HorizontalDivider()
                        BalanceAmountRow(amount, first = index == 0, low = state.low)
                    }
                    HorizontalDivider()
                    BalanceValueRow(DeepSeekBalance.UPDATED, DeepSeekBalance.ago(state.fetchedAt, now))
                    HorizontalDivider()
                    RefreshRow(DeepSeekBalance.REFRESH, refreshing) { refresh() }
                    HorizontalDivider()
                    if (state.low) Button(onClick = { runCatching { uri.openUri(DeepSeekBalance.TOP_UP_URL) } }, Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        shape = RoundedCornerShape(14.dp)) { Text("${DeepSeekBalance.TOP_UP} ↗", fontWeight = FontWeight.SemiBold) }
                    else TextButton(onClick = { runCatching { uri.openUri(DeepSeekBalance.TOP_UP_URL) } }) { Text("${DeepSeekBalance.TOP_UP} ↗") }
                }
                is DeepSeekBalance.State.Failed -> {
                    BalanceAlert(Ink.amber, DeepSeekBalance.FAILED_TITLE, DeepSeekBalance.detail(state.failure, state.message))
                    HorizontalDivider()
                    BalanceValueRow(DeepSeekBalance.BALANCE, DeepSeekBalance.UNKNOWN)
                    state.triedAt?.let { HorizontalDivider(); BalanceValueRow(DeepSeekBalance.LAST_TRIED, DeepSeekBalance.ago(it, now)) }
                    HorizontalDivider()
                    RefreshRow(DeepSeekBalance.RETRY, refreshing) { refresh() }
                }
            }
        }
        // Every engine the key runs on, then the key itself (board 2): one key, one page, whichever engine a session spends it on.
        val engines = KeyEngines.engines(provider).map(ProviderEngines::cliName)
        if (engines.isNotEmpty()) FormSection(KeyEngines.WORKS_WITH, footer = KeyEngines.WORKS_WITH_FOOTER) {
            engines.forEachIndexed { index, name ->
                if (index > 0) HorizontalDivider()
                Text(name, Modifier.padding(vertical = 10.dp))
            }
        }
        FormSection(KeyEngines.KEY, footer = KeyEngines.footer(engines)) {
            BalanceValueRow(KeyEngines.PROTOCOL, KeyEngines.protocol(provider.str("runtime")))
            providerKeyLine(provider)?.let { HorizontalDivider(); BalanceValueRow(DeepSeekBalance.DEFAULT_MODEL, it) }
            DeepSeekBalance.endpointHost(provider)?.let { HorizontalDivider(); BalanceValueRow(DeepSeekBalance.ENDPOINT, it) }
        }
        Spacer(Modifier.height(48.dp))
    }
}

/** Whose balance this is: the whole account's, not what anything spent — and, while there is none, that none is drawn. */
@Composable
private fun ColumnScope.BalanceFooter(state: DeepSeekBalance.State) {
    val style = MaterialTheme.typography.bodySmall
    when (state) {
        DeepSeekBalance.State.Loading -> Unit
        is DeepSeekBalance.State.Failed -> Text(DeepSeekBalance.NO_AMOUNT_YET, style = style, color = Ink.muted)
        is DeepSeekBalance.State.Read -> {
            Text(if (state.low) "${DeepSeekBalance.OPENS_IN_BROWSER} ${DeepSeekBalance.NOTE}" else DeepSeekBalance.NOTE, style = style, color = Ink.muted)
            if (state.balances.size > 1) Text(DeepSeekBalance.MULTI_CURRENCY, style = style, color = Ink.muted)
            DeepSeekBalance.sameAccount(state.sharedWith)?.let { (lead, names, tail) ->
                Text(buildAnnotatedString { append(lead); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(names) }; append(tail) },
                    style = style, color = Ink.muted)
            }
        }
    }
}

/** The balance's alert, at the top of its section: why there is no balance, or that the one there is can't pay for another request. */
@Composable
private fun BalanceAlert(tone: Color, title: String, detail: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(10.dp)).background(tone.copy(alpha = .14f)).padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("!", Modifier.size(22.dp).clip(CircleShape).background(tone).wrapContentSize(), color = Color.White, fontWeight = FontWeight.Bold)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = tone)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
    }
}

/** One currency of the balance: its total, then how much of it was granted and how much topped up. */
@Composable
private fun BalanceAmountRow(amount: JsonObject, first: Boolean, low: Boolean) {
    val currency = amount.text("currency")
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Column {
            if (first) Text(DeepSeekBalance.TOTAL, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(DeepSeekBalance.amount(amount.text("totalBalance"), currency),
                    style = (if (first) MaterialTheme.typography.displaySmall else MaterialTheme.typography.headlineSmall).copy(fontWeight = FontWeight.SemiBold),
                    color = if (low) Ink.red else MaterialTheme.colorScheme.onSurface)
                Text(currency, Modifier.padding(bottom = 4.dp), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            }
        }
        val split = DeepSeekBalance.split(amount)
        Row(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = .08f))) {
            split?.let {
                if (it.granted > 0) Box(Modifier.weight(it.granted.toFloat()).fillMaxHeight().background(MaterialTheme.colorScheme.primary.copy(alpha = .35f)))
                if (it.toppedUp > 0) Box(Modifier.weight(it.toppedUp.toFloat()).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            }
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            BalanceLegend(MaterialTheme.colorScheme.primary.copy(alpha = .35f), DeepSeekBalance.GRANTED, DeepSeekBalance.amount(amount.text("grantedBalance"), currency))
            BalanceLegend(MaterialTheme.colorScheme.primary, DeepSeekBalance.TOPPED_UP, DeepSeekBalance.amount(amount.text("toppedUpBalance"), currency))
        }
    }
}

@Composable
private fun BalanceLegend(tint: Color, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(tint))
        Text(label, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        Text(value, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
    }
}

@Composable
private fun BalanceValueRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Text(value, color = Ink.muted)
    }
}

@Composable
private fun RefreshRow(title: String, refreshing: Boolean, refresh: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = refresh, enabled = !refreshing) { Text("↻ $title") }
        if (refreshing) { Spacer(Modifier.weight(1f)); CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }
    }
}

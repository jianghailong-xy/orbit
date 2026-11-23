package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** One blocked account (GET /account-health; docs/account-health-owner-surface-contract.md §2). */
internal data class AccountHealthBlock(
    val id: String, val runnerId: String?, val engine: String?, val account: String?, val scopeModel: String,
    val kind: String, val said: String?, val trips: Int, val since: String?, val nextTrialAt: String?,
    val trialRunning: Boolean, val line: String?,
) {
    val classified get() = kind != UNCLASSIFIED

    companion object {
        const val UNCLASSIFIED = "UNCLASSIFIED_ADMISSION"
        private val PRODUCT = mapOf("claude" to "Claude Code", "codex" to "Codex", "kimi" to "Kimi Code", "antigravity" to "Antigravity", "cursor" to "Cursor")

        fun parse(body: JsonElement): List<AccountHealthBlock> = ((body as? JsonObject)?.get("blocks") as? JsonArray).orEmpty().mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            fun str(key: String) = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            AccountHealthBlock(str("id") ?: return@mapNotNull null, str("runnerId"), str("engine"), str("account"), str("scopeModel").orEmpty(),
                str("kind").orEmpty(), str("said"), (o["trips"] as? JsonPrimitive)?.intOrNull ?: 0, str("since"), str("nextTrialAt"),
                (o["trialRunning"] as? JsonPrimitive)?.booleanOrNull == true, str("line"))
        }

        /** The whole-account block of a runner's sign-in (`default` for the machine's one login), if there is one. */
        fun forRunnerAccount(blocks: List<AccountHealthBlock>, runnerId: String, engine: String, account: String) =
            blocks.firstOrNull { it.runnerId == runnerId && it.engine == engine && it.account == account && it.scopeModel.isEmpty() }

        private fun clock(ms: Long, zone: ZoneId, pattern: String) = DateTimeFormatter.ofPattern(pattern, Locale.US).withZone(zone).format(Instant.ofEpochMilli(ms))

        /**
         * The row's line: `Needs action · Cursor said "Add a payment method to continue" · since Nov 22, 17:19 · tried again at 21:19`;
         * the breaker's guess `Not used for now · failed to start 2 runs · since … · tried again at …` (web `AccountHealthBlockLine`).
         */
        fun text(block: AccountHealthBlock, zone: ZoneId = ZoneId.systemDefault()): String {
            val product = block.engine?.let { PRODUCT[it] } ?: "The provider"
            val lead = block.line?.takeIf { it.isNotBlank() } ?: if (block.classified)
                block.said?.let { "Needs action · $product said \"$it\"" } ?: "Needs action · $product refused this account"
            else "Not used for now · failed to start ${block.trips + 1} runs"
            val since = isoMs(block.since)?.let { "since ${clock(it, zone, "MMM d, HH:mm")}" }
            val next = if (block.trialRunning) "trying it now" else isoMs(block.nextTrialAt)?.let { "tried again at ${clock(it, zone, "HH:mm")}" }
            return listOfNotNull(lead, since, next).joinToString(" · ")
        }
    }
}

/**
 * A blocked account's line on its row, with Check again (§8 item 2 of docs/routing-account-health-design.md): drawn only while the
 * account is blocked. Check again calls POST /account-health/:id/check, then reads the blocks again; a 404 is "nothing to clear".
 */
@Composable
internal fun AccountHealthLine(api: ManagementApi, runnerId: String, engine: String, account: String) {
    var blocks by remember(runnerId) { mutableStateOf<List<AccountHealthBlock>>(emptyList()) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(runnerId, reload) { runCatching { blocks = AccountHealthBlock.parse(api.get("account-health")) } }
    val block = AccountHealthBlock.forRunnerAccount(blocks, runnerId, engine, account) ?: return
    AccountHealthBlockLine(block, check = { api.post("account-health/${block.id}/check") }, onChecked = { reload++ })
}

@Composable
internal fun AccountHealthBlockLine(block: AccountHealthBlock, check: suspend () -> Unit, onChecked: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pressing by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().testTag("account-health"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(AccountHealthBlock.text(block), Modifier.weight(1f).testTag("account-health:line"),
                style = MaterialTheme.typography.labelMedium.let { if (block.classified) it.copy(fontWeight = FontWeight.SemiBold) else it },
                color = if (block.classified) Ink.amber else Ink.muted)
            OutlinedButton(enabled = !pressing, modifier = Modifier.testTag("account-health:check"), onClick = {
                pressing = true; failure = null
                scope.launch {
                    // A row already cleared answers 404: nothing to clear, not an error to show.
                    runCatching { check() }.onFailure { if (!it.toString().contains("404")) failure = "Couldn't check again" }
                    pressing = false; onChecked()
                }
            }) { Text("Check again") }
        }
        failure?.let { Text(it, Modifier.testTag("account-health:error"), style = MaterialTheme.typography.labelMedium, color = Ink.red) }
    }
}

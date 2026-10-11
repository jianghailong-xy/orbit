package io.orbitd.android.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

/**
 * The Codex reset-credit card's rules (iOS `ConsoleModel`'s codexReset… and `CodexResetCreditView`, the baseline the audit found
 * missing; c3a2e1463 for A07-9): which block is the session's to spend, whether it is drawn, what it says, and why its one
 * destructive press is or isn't offered. Every refusal fails closed: an action the server would refuse is never presented.
 */
internal object CodexReset {
    const val CAPABILITY = "codex-rate-limit-reset-v1"
    private val identified = setOf("SUPPORTED", "CREDITS_UNAVAILABLE")
    private val supports = identified + setOf("PROVIDER_UNSUPPORTED", "UNSUPPORTED_AUTH", "ACCOUNT_UNIDENTIFIED")

    /** The reset block is offered only for the runner's built-in Codex Default account: a key, a CODEX_HOME of its own or another
     * account would spend a different credential, and the API must refuse it. */
    fun block(detail: JsonObject, usage: JsonObject?): JsonObject? {
        if (detail.text("provider") != "codex" || account(detail) != "default") return null
        return usage?.get("rateLimitReset") as? JsonObject
    }
    /** The session's Codex account: its own, else its workspace's, else Default. */
    private fun account(detail: JsonObject) = detail.text("codexAccount")?.takeIf { it.isNotBlank() } ?: workspace(detail)?.text("codexAccount")
        ?.takeIf { it.isNotBlank() } ?: "default"
    private fun workspace(detail: JsonObject) = detail["workspace"] as? JsonObject ?: detail.takeIf { "codexAccount" in it || "env" in it }

    fun date(value: String?): Long? = value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    fun isFingerprint(value: String?) = value != null && value.length == 37 && value.startsWith("cxa1_") && value.drop(5).all { it in "0123456789abcdef" }
    fun isUuid(value: String?): Boolean {
        if (value == null || value.length != 36) return false
        value.forEachIndexed { index, c ->
            if (index in setOf(8, 13, 18, 23)) { if (c != '-') return false } else if (c !in "0123456789abcdef") return false
        }
        return value[14] in "12345678" && value[19] in "89ab"
    }
    private fun credits(block: JsonObject) = block["rateLimitResetCredits"] as? JsonObject
    fun availableCount(block: JsonObject?) = block?.let(::credits)?.get("availableCount")?.jsonPrimitive?.intOrNull

    /** A block from a newer or malformed contract is not drawn: the API checks the same before it stores runner telemetry. */
    fun isValid(block: JsonObject): Boolean {
        val support = block.text("support") ?: return false
        val fingerprint = block.text("accountFingerprint")
        val credits = credits(block)
        if (block["protocolVersion"]?.jsonPrimitive?.intOrNull != 1 || support !in supports) return false
        if ((support in identified) != (fingerprint != null)) return false
        if (fingerprint != null && !isFingerprint(fingerprint)) return false
        if ((support == "SUPPORTED") != (credits != null)) return false
        if (date(block.text("fetchedAt")) == null || !isUuid(block.text("generation"))) return false
        if ((block["sequence"]?.jsonPrimitive?.intOrNull ?: 0) < 1) return false
        if (credits == null) return true
        return (credits["availableCount"]?.jsonPrimitive?.intOrNull ?: -1) >= 0 && ((credits["credits"] as? JsonArray)?.size ?: 0) <= 100
    }

    /** Whether the usage sheet draws the card: an identified account with credits to speak of. Unsupported or unidentified answers
     * stay hidden, and so — A07-9, iOS c3a2e1463 — does an account with none available: only its usage windows remain. */
    fun visible(block: JsonObject?): Boolean = block != null && isValid(block) && isFingerprint(block.text("accountFingerprint")) &&
        availableCount(block) != 0 && block.text("support") in identified

    fun countLabel(block: JsonObject) = availableCount(block)?.let { "$it available" } ?: "Count unavailable"

    /** The earliest expiry among the listed credits still available, or null when none says. */
    fun nextExpiry(block: JsonObject): String? = (credits(block)?.get("credits") as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
        .filter { it.text("status") == "available" }.mapNotNull { it.text("expiresAt") }.minOrNull()

    fun expiryLabel(block: JsonObject, zone: ZoneId = ZoneId.systemDefault()): String? {
        val count = availableCount(block)?.takeIf { it > 0 } ?: return null
        val listed = (credits(block)?.get("credits") as? JsonArray)?.filterIsInstance<JsonObject>() ?: return "Expiry not reported"
        val partial = listed.count { it.text("status") == "available" } < count
        nextExpiry(block)?.let { expiry ->
            val date = formatDate(expiry, zone)
            return if (partial) "Earliest listed expires $date · partial list" else if (count > 1) "Next expires $date" else "Expires $date"
        }
        if (listed.none { it.text("status") == "available" }) return "Expiry not reported"
        return if (partial) "Listed credits don't expire · partial list" else "Doesn't expire"
    }

    private fun formatDate(iso: String, zone: ZoneId) = date(iso)?.let {
        DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.US).format(Instant.ofEpochMilli(it).atZone(zone))
    } ?: iso

    /** The web contract's fence: a snapshot fifteen minutes old at most, five minutes ahead of this clock at most. */
    fun fresh(block: JsonObject, nowMs: Long): Boolean {
        val fetched = date(block.text("fetchedAt")) ?: return false
        val age = nowMs - fetched
        return age >= -5 * 60_000 && age <= 15 * 60_000
    }

    fun freshnessText(block: JsonObject, nowMs: Long): String? {
        val fetched = date(block.text("fetchedAt")) ?: return null
        if (fetched - nowMs > 5 * 60_000) return "Updated at a time ahead of this device's clock"
        val minutes = maxOf(0, ((nowMs - fetched) / 60_000).toInt())
        val ago = if (minutes < 1) "just now" else if (minutes < 60) "$minutes min ago" else "${minutes / 60} h ago"
        return if (fresh(block, nowMs)) "Updated $ago" else "Updated $ago · out of date"
    }

    fun isActive(operation: JsonObject?) = when (operation?.text("status")) {
        null -> false
        "SUCCEEDED", "REFRESH_FAILED", "NOTHING_TO_RESET", "NO_CREDIT", "NOT_ATTEMPTED", "UNRESOLVED" -> false
        // A newer server may add an active checkpoint before this client knows its spelling: fail closed.
        else -> true
    }

    /** The workspace's own pick decides the account the API judges, and its env can bring a credential of its own. */
    fun accountOverride(detail: JsonObject, draft: Boolean, resumeAccount: String?): Boolean {
        if (detail.text("provider") != "codex" || account(detail) != "default") return true
        val workspace = workspace(detail)
        val picked = (if (draft) resumeAccount ?: workspace?.text("codexAccount") else workspace?.text("codexAccount"))?.trim()
        if (!picked.isNullOrEmpty() && picked != "default") return true
        val env = workspace?.get("env") as? JsonObject ?: return false
        return env.entries.any { (key, value) ->
            (key == "CODEX_HOME" || key == "CODEX_API_KEY" || key.startsWith("OPENAI_")) && (value as? JsonPrimitive)?.contentOrNull?.isNotBlank() == true
        }
    }

    /** Why the press isn't offered, in the order the server would refuse it; null when it is. */
    fun eligibilityReason(block: JsonObject, runner: JsonObject?, override: Boolean, operation: JsonObject?, operations: JsonObject?,
        nowMs: Long): String? {
        if (override) return "This workspace doesn't run on the runner's own Codex sign-in."
        if (isActive(operation) || isActive(operations?.get("active") as? JsonObject)) return "A reset is already in progress for this Codex account."
        if (runner?.get("online")?.jsonPrimitive?.booleanOrNull != true) return "The runner is offline."
        if (runner.strings("capabilities").none { it.trim().lowercase() == CAPABILITY }) return "Update this runner to use reset credits."
        if (!isUuid(runner.text("heartbeatLeaseOwner"))) return "The runner hasn't checked in yet."
        if (runner["heartbeatDraining"]?.jsonPrimitive?.booleanOrNull == true) return "The runner is restarting."
        if (block.text("support") !in identified) return "Reset credits are not supported by this Codex account."
        val fingerprint = block.text("accountFingerprint")
        if (fingerprint.isNullOrEmpty()) return "Codex didn't identify this account."
        if (!fresh(block, nowMs)) return "Usage is out of date. Waiting for the runner to refresh it."
        val latest = operations?.get("latest") as? JsonObject
        if (latest != null && latest.text("accountFingerprint") == fingerprint && latest.text("completedAt") != null &&
            (latest.text("consumeState") == "UNRESOLVED" || (latest.text("consumeState") == "CONFIRMED" && latest.text("refreshState") == "FAILED"))) {
            val completed = date(latest.text("completedAt")); val fetched = date(block.text("fetchedAt"))
            if (completed == null || fetched == null || fetched <= completed) return "Usage hasn't refreshed since the last reset attempt."
        }
        val credits = credits(block)
        if (block.text("support") != "SUPPORTED" || credits == null) return "Codex isn't reporting reset credits right now."
        if ((credits["availableCount"]?.jsonPrimitive?.intOrNull ?: 0) <= 0) return "No reset credits available."
        return null
    }

    fun refusalReason(code: String?): String? = when (code) {
        "REQUEST_ID_REUSED" -> "That request couldn't be matched to this runner. Try again."
        "ACCOUNT_OVERRIDE" -> "This workspace doesn't run on the runner's own Codex sign-in."
        "OPERATION_IN_FLIGHT" -> "A reset is already in progress for this Codex account."
        "RUNNER_OFFLINE" -> "The runner is offline."
        "CAPABILITY_MISSING" -> "Update this runner to use reset credits."
        "NO_ACTIVE_LEASE" -> "The runner hasn't checked in yet."
        "RUNNER_DRAINING" -> "The runner is restarting."
        "SNAPSHOT_MISSING" -> "This runner hasn't reported reset credits."
        "UNSUPPORTED_AUTH" -> "Reset credits need a ChatGPT sign-in on this runner."
        "PROVIDER_UNSUPPORTED" -> "This runner's Codex CLI doesn't support reset credits."
        "ACCOUNT_UNIDENTIFIED" -> "Codex didn't say which account this is."
        "ACCOUNT_MISMATCH" -> "The runner's Codex account changed. Check the updated usage."
        "SNAPSHOT_STALE" -> "Usage is out of date. Waiting for the runner to refresh it."
        "CREDITS_UNAVAILABLE" -> "Codex isn't reporting reset credits right now."
        "NO_CREDIT_AVAILABLE" -> "No reset credits available."
        else -> null
    }

    fun progress(operation: JsonObject) = when (operation.text("status")) {
        "PENDING" -> "Waiting for the runner…"
        "CONSUMING" -> "Using reset credit…"
        "REFRESHING" -> if (operation.text("consumeOutcome") in setOf("reset", "alreadyRedeemed")) "Limits reset — refreshing usage…" else "Refreshing plan usage…"
        else -> "Reset in progress…"
    }

    fun result(operation: JsonObject) = when (operation.text("status")) {
        "SUCCEEDED" -> if (operation.text("consumeOutcome") == "alreadyRedeemed") "Usage limits reset · credit was already used" else "Usage limits reset · 1 credit used"
        "NOTHING_TO_RESET" -> "Nothing to reset"
        "NO_CREDIT" -> "No reset credit was available"
        "REFRESH_FAILED" -> if (operation.text("consumeOutcome") == "alreadyRedeemed") "Limits reset · credit was already used, usage not refreshed"
            else "Limits reset · 1 credit used, usage not refreshed"
        "NOT_ATTEMPTED" -> "The reset was not attempted"
        "UNRESOLVED" -> "Result unknown · a credit may have been used"
        else -> "Reset could not be completed"
    }
}

/** The runner's reset operations as this sheet follows them (iOS `ConsoleModel`): the active one polled until it settles, a
 * dropped POST retried under the same request id so a retry can't spend a second credit. */
@Stable
internal class CodexResetModel(private val api: ManagementApi, val runnerId: String) {
    var runner by mutableStateOf<JsonObject?>(null)
    var operations by mutableStateOf<JsonObject?>(null); private set
    var operation by mutableStateOf<JsonObject?>(null); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var requestId: String? = null

    /** The runner again: a refusal may reflect a newer heartbeat, account or snapshot than the one this sheet drew. */
    private suspend fun refreshRunner() {
        runner = runCatching { (api.get("runners") as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { ObjectId.same(it.text("id"), runnerId) } }
            .getOrNull() ?: runner?.let { JsonObject(it - setOf("online", "heartbeatLeaseOwner", "heartbeatDraining")) }
    }

    /** Read the operations when the sheet opens: an active one another device started is followed, not raced. */
    suspend fun load() {
        try {
            val read = api.get("runners/$runnerId/codex-rate-limit-reset") as? JsonObject ?: return
            operations = read
            val active = read["active"] as? JsonObject
            if (active != null) { operation = active; follow(active.text("id") ?: return) }
            else {
                val latest = read["latest"] as? JsonObject
                if (operation != null && latest != null && latest.text("id") == operation?.text("id")) operation = latest
                refreshRunner()
            }
            error = null
        } catch (cancel: CancellationException) { throw cancel } catch (e: Exception) { error = directoryError(e) }
    }

    private suspend fun follow(id: String) {
        while (true) {
            delay(2_500)
            try {
                val read = api.get("runners/$runnerId/codex-rate-limit-reset/$id") as? JsonObject ?: continue
                operation = read
                operations = buildJsonObject { if (CodexReset.isActive(read)) put("active", read) else put("active", JsonNull); put("latest", read) }
                if (!CodexReset.isActive(read)) { refreshRunner(); return }
                error = null
            } catch (cancel: CancellationException) { throw cancel } catch (e: Exception) { error = directoryError(e) }
        }
    }

    /** Spend one credit, once confirmed. */
    suspend fun use(fingerprint: String, workspaceId: String?) {
        if (busy) return
        busy = true; error = null
        val id = requestId ?: UUID.randomUUID().toString().also { requestId = it }
        try {
            val response = api.post("runners/$runnerId/codex-rate-limit-reset", buildJsonObject {
                put("clientRequestId", id); put("accountFingerprint", fingerprint); workspaceId?.let { put("workspaceId", it) }
            }) as? JsonObject
            requestId = null
            val started = response?.get("operation") as? JsonObject
            operation = started
            operations = buildJsonObject { put("active", if (CodexReset.isActive(started)) started ?: JsonNull else JsonNull); put("latest", started ?: JsonNull) }
            busy = false
            if (started != null && CodexReset.isActive(started)) follow(started.text("id").orEmpty()) else refreshRunner()
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) {
            val code = (e as? ApiError)?.code
            error = CodexReset.refusalReason(code) ?: "Couldn't use reset credit — ${directoryError(e)}."
            refreshRunner()
            if (code == "OPERATION_IN_FLIGHT") load() else if (code != null) requestId = null
        } finally { busy = false }
    }
}

/** iOS `CodexResetCreditCard`: the earned reset credits of the runner's own Codex sign-in, in the Plan usage sheet. */
@Composable
internal fun CodexResetCreditCard(model: CodexResetModel, block: JsonObject, override: Boolean, workspaceId: String?) {
    val scope = rememberCoroutineScope()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var confirming by remember { mutableStateOf(false) }
    // Read as the sheet opens, and again every 30 seconds while it stays.
    LaunchedEffect(model) { model.load(); while (true) { delay(30_000); now = System.currentTimeMillis(); model.load() } }
    val reason = CodexReset.eligibilityReason(block, model.runner, override, model.operation, model.operations, now)
    val eligible = reason == null
    val brand = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxWidth().testTag("codex-reset-credit"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth().background(brand.copy(alpha = .10f), RoundedCornerShape(14.dp)).padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("✓", color = brand, style = MaterialTheme.typography.titleLarge, modifier = Modifier.clearAndSetSemantics { })
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("Reset credit", color = brand, style = MaterialTheme.typography.titleSmall)
                Text(CodexReset.countLabel(block), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                CodexReset.expiryLabel(block)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                CodexReset.freshnessText(block, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        val operation = model.operation
        if (operation != null && CodexReset.isActive(operation)) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text(CodexReset.progress(operation), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (operation != null && !operation.text("status").isNullOrEmpty()) Text(CodexReset.result(operation), style = MaterialTheme.typography.bodySmall,
            color = if (operation.text("status") == "SUCCEEDED") LocalOrbitColors.current.success else MaterialTheme.colorScheme.onSurfaceVariant)
        reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        model.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        Button(enabled = eligible && !model.busy, onClick = { confirming = true }, modifier = Modifier.fillMaxWidth()) {
            if (model.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("Use reset credit", fontWeight = FontWeight.SemiBold)
        }
    }
    if (confirming) AlertDialog(onDismissRequest = { confirming = false }, title = { Text("Use reset credit?") },
        text = { Text("This consumes 1 earned credit and resets eligible Codex usage windows. This action can't be undone. Your conversations and context aren't affected.") },
        confirmButton = { TextButton(onClick = {
            confirming = false
            block.text("accountFingerprint")?.let { fingerprint -> scope.launch { model.use(fingerprint, workspaceId) } }
        }) { Text("Use reset") } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } })
}

package io.orbitd.android.reader

import kotlinx.serialization.json.*

/**
 * Failures a runtime reports as ordinary text, and which of them fix themselves — OrbitKit's
 * `EngineErrors`, itself a copy of @orbit/shared `events.ts` (`EngineErrorsParityTest` reads that
 * file back). A spent quota, an overloaded provider and a content-filtered request all arrive as a
 * plain `assistant` reply, so this is what lets the reply become an error row or a self-healing
 * auto-retry row instead of the agent "answering" "API Error: 529".
 */
internal object EngineErrors {
    /** Keys on the stable `API Error` prefix Claude Code uses. Heuristic, intentionally narrow. */
    fun isApiErrorText(text: String?): Boolean = text != null && text.trimStart().startsWith("API Error")

    /** Statuses that describe the provider, not the request: a plain re-send succeeds once it recovers. */
    internal val retryableStatuses = setOf(408, 429, 500, 502, 503, 504, 529)

    /** Codeless transport phrasings, only as observed: a missing entry costs a manual retry, a guessed one a silent loop. */
    internal val retryableMarkers = listOf("mid-response", "mid-stream", "connection error", "timed out", "timeout",
        "internal server error", "overloaded", "empty or malformed response")

    /** The raw dump ("API Error: 429 …"), then the rejection wrapper ("API Error: Request rejected (429) · …"). */
    internal val statusPatterns = listOf(Regex("^\\s*api error:?\\s*(\\d{3})\\b"),
        Regex("^\\s*api error:?\\s*request rejected \\((\\d{3})\\)"))

    /** The same transient failure in a runtime's own words (Codex reports it as the turn's error), matched at the start. */
    internal val retryableEngineErrorPrefixes = listOf("selected model is at capacity",
        // Codex's rate-limit retry budget: "exceeded retry limit, last status: 429 Too Many Requests".
        "exceeded retry limit, last status: 429 too many requests")

    /** The provider briefly unable to answer, rather than anything about the message. Default is NOT retryable. */
    fun isRetryableApiErrorText(text: String?): Boolean {
        if (text == null) return false
        val opening = text.trimStart().lowercase()
        if (retryableEngineErrorPrefixes.any { opening.startsWith(it) }) return true
        if (!isApiErrorText(text)) return false
        val lower = text.lowercase()
        // The status, when there is one, is authoritative: a 400 that mentions "timeout" is still a 400.
        val status = statusPatterns.firstNotNullOfOrNull { it.find(lower)?.groupValues?.get(1)?.toIntOrNull() }
        if (status != null) return status in retryableStatuses
        return retryableMarkers.any { lower.contains(it) }
    }

    internal val usageLimitMarkers = listOf("hit your usage limit", "hit your session limit", "hit your weekly limit")

    /** How far in the quota sentence may begin; past it the reply is quoting one, not being one. */
    internal const val USAGE_LIMIT_MAX_OFFSET = 40

    /** A run killed by the account's quota running out: the reply must open with the provider's sentence. */
    fun isUsageLimitErrorText(text: String?): Boolean {
        if (text == null) return false
        val lower = text.trimStart().lowercase()
        return usageLimitMarkers.any { lower.indexOf(it) in 0..USAGE_LIMIT_MAX_OFFSET }
    }

    /** The auto-retry card's own title for a failure that fixes itself (OrbitKit `AutoRetryLogic`). */
    fun autoRetryTitle(quota: Boolean, message: String): String =
        if (!quota) "Provider unavailable" else "${quotaWindow(message).replaceFirstChar(Char::uppercase)} reached"

    /** Which quota window a usage-limit message says ran out (web `quotaWindow`): the runtime's "session limit" is its 5-hour one. */
    fun quotaWindow(message: String): String {
        val m = message.lowercase()
        return when {
            m.contains("hit your session limit") -> "5-hour limit"
            m.contains("hit your weekly limit") -> "weekly limit"
            else -> "usage limit"
        }
    }
}

/** Readying an engine's raw stderr line for the transcript — OrbitKit's `EngineStderr`, web's `isBenignEngineStderr`. */
internal object EngineStderr {
    private val ansi = Regex("\u001B\\[[0-9;?]*[ -/]*[@-~]")
    private val leadingTimestamp = Regex("^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?\\s*")

    /** Trimmed and stripped of ANSI colour codes, which events stored before the runner stripped them still carry. */
    fun clean(raw: String): String = raw.replace(ansi, "").trim()

    /** Two occurrences of one line fold on the line minus its leading ISO-8601 timestamp. */
    fun foldKey(line: String): String = line.replace(leadingTimestamp, "")

    /** A verification error whose explanation continues on the next stderr event ends in a colon. */
    fun canStartContinuation(line: String): Boolean =
        line.contains("verification failed:", ignoreCase = true) && line.trim().endsWith(":")

    /** A timestamped line always starts a new logger record. */
    fun startsNewLog(line: String): Boolean = leadingTimestamp.containsMatchIn(line)

    /** Noise Orbit's own env injection provokes; a known list, never a "warnings aren't errors" rule. */
    private val benignMarkers = listOf("claude.ai connectors are disabled", "[claude-code:unrecognized_model]")

    fun isBenign(line: String): Boolean = benignMarkers.any { line.contains(it) }

    /** Events persisted before `payload.diagnostic` existed: these exact auxiliary failures were already known non-fatal. */
    fun legacyRecoverableLabel(line: String): String? {
        val lower = line.lowercase()
        val tokenInvalidated = lower.contains("token_invalidated") || lower.contains("token has been invalidated")
        if (lower.contains("codex_models_manager") && lower.contains("failed to refresh available models") &&
            lower.contains("401") && tokenInvalidated) return "Startup · model_catalog · token_invalidated"
        if (lower.contains("rmcp::transport::worker") && lower.contains("401") && tokenInvalidated)
            return "Startup · mcp_transport · token_invalidated"
        return null
    }

    /**
     * A structured diagnostic that says it is recoverable or degraded, as the notice it reads as
     * ("Startup · model_catalog · token_invalidated: …"). Nil keeps the old error path: the runner keeps
     * the raw stderr beside the metadata, so an unknown or malformed diagnostic stays an error.
     */
    fun recoverableDiagnostic(payload: JsonObject): String? {
        val message = clean(payload.string("stderr") ?: return null)
        if (message.isEmpty()) return null
        val raw = payload["diagnostic"] as? JsonObject ?: return legacyRecoverableLabel(message)?.let { "$it: $message" }
        fun field(key: String) = (raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }
        val impact = field("impact")?.lowercase()
        val severity = field("severity")?.lowercase()
        val recoverable = (raw["recoverable"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
        if (!recoverable && severity != "warn" && severity != "warning" &&
            impact !in setOf("recoverable", "degraded", "warning", "warn", "non-fatal", "nonfatal")) return null
        val phase = field("phase")?.let { if (it == "startup") "Startup" else it }
        val label = listOfNotNull(phase, field("component"), field("code")).joinToString(" · ")
        return if (label.isEmpty()) message else "$label: $message"
    }

    /**
     * A tool failure written to stderr without a tool_result: the named tool for a verification failure,
     * nil for a parser failure that omits it. Null for anything else, which stays an ordinary stderr row.
     */
    fun toolFailure(line: String): ToolFailureLine? {
        val marker = line.indexOf("error=", ignoreCase = true)
        if (marker < 0) return null
        val tail = line.substring(marker).trim()
        val rest = tail.drop("error=".length)
        val lower = rest.lowercase()
        val separator = lower.indexOf(" verification failed:")
        if (separator >= 0) return ToolFailureLine(rest.substring(0, separator), rest.substring(separator + " verification failed:".length))
        if (lower.startsWith("failed to parse function arguments")) return ToolFailureLine(null, rest)
        return null
    }
}

internal data class ToolFailureLine(val tool: String?, val reason: String)

/**
 * The compact card an engine's tool failure is folded to (iOS `ToolFailureSummary`): tool, the worktree
 * path it names, and a stable reason. The original message stays one tap away.
 */
internal data class ToolFailureSummary(val tool: String?, val path: String?, val reason: String) {
    companion object {
        fun parse(message: String): ToolFailureSummary? {
            val clean = message.replace("\r\n", "\n")
            val marker = clean.indexOf("error=", ignoreCase = true)
            if (marker < 0) return null
            val tail = clean.substring(marker).trim()
            val rest = tail.drop("error=".length)
            val lowerRest = rest.lowercase()
            val tool: String?
            val detail: String
            val verification = lowerRest.indexOf(" verification failed:")
            if (verification >= 0) {
                tool = rest.substring(0, verification).ifEmpty { return null }
                detail = rest.substring(verification + " verification failed:".length).trim()
            } else if (lowerRest.startsWith("failed to parse function arguments")) {
                tool = null
                detail = rest.trim()
            } else {
                // Router failures that are not verification failures still carry the tool after `error=`.
                val token = rest.split(' ', '\n', ':').firstOrNull { it.isNotEmpty() } ?: return null
                tool = token.split('.').firstOrNull { it.isNotEmpty() }
                detail = rest.trim()
            }
            val path = detail.indexOf("/worktrees/").takeIf { it >= 0 }?.let { at ->
                val afterWorktree = detail.substring(at + "/worktrees/".length)
                val slash = afterWorktree.indexOf('/').takeIf { it >= 0 } ?: return@let null
                afterWorktree.substring(slash + 1).takeWhile { it != ':' && it != '\n' && it != ' ' }.ifEmpty { null }
            }
            val lower = detail.lowercase()
            val reason = when {
                lower.startsWith("invalid patch:") -> "Invalid patch"
                lower.startsWith("failed to find expected lines") -> "Expected lines not found"
                lower.startsWith("failed to parse function arguments") -> detail
                lowerRest.contains("verification failed:") -> "Patch verification failed"
                else -> detail
            }
            return ToolFailureSummary(tool, path, reason)
        }
    }
}

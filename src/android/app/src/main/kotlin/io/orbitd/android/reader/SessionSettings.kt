package io.orbitd.android.reader

import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What the session page's Settings (docs/mocks/session-settings, Android frames ⑤-⑦) reads off `GET /sessions/:id` — its
 * `settings`, `usage` and `engineVersion` — and the bodies its writes send: `PATCH /sessions/:id/settings`, `PUT /sessions/:id/tags`,
 * `POST /sessions/:id/restart`. Every change goes as it is made; there is no Save.
 */
internal object SessionSettings {
    /** Claude Code's own variable for the size it compacts near (web `AutoCompactSelect`): Compact at writes it into the session's
     * variables, so it reaches the engine the way the rest of them do, and the Variables page leaves it to that row. */
    const val COMPACT_VARIABLE = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
    val COMPACT_SIZES = listOf("700000", "500000", "300000")
    private val KEY = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /** `SessionNotifyOverride`: the account's own choice in Settings, or this session's. */
    enum class Notify(val wire: String, val label: String) {
        INHERIT("inherit", "As in Settings"), ON("on", "Notify"), OFF("off", "Don't notify");
        companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: INHERIT }
    }

    data class State(val env: Map<String, String>, val workspaceEnv: Map<String, String>, val notifyTurnFinished: Notify,
        val notifyNeedsYou: Notify, val muted: Boolean, val envPendingRestart: Boolean)

    data class Usage(val inputTokens: Long, val outputTokens: Long, val cacheReadTokens: Long, val cacheCreationTokens: Long,
        val costUsd: Double, val numTurns: Int)

    data class Label(val id: String, val name: String, val color: String?)

    /** `settings` as GET /sessions/:id and PATCH /sessions/:id/settings answer it; null from a server that has none. */
    fun state(settings: JsonElement?): State? {
        val o = settings as? JsonObject ?: return null
        return State(map(o["env"]), map(o["workspaceEnv"]), Notify.of(o.string("notifyTurnFinished")), Notify.of(o.string("notifyNeedsYou")),
            o.string("muted") == "true", o.string("envPendingRestart") == "true")
    }

    fun usage(detail: JsonObject): Usage? {
        val o = detail["usage"] as? JsonObject ?: return null
        fun long(key: String) = (o[key] as? JsonPrimitive)?.doubleOrNull?.toLong() ?: 0L
        return Usage(long("inputTokens"), long("outputTokens"), long("cacheReadTokens"), long("cacheCreationTokens"),
            (o["costUsd"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, long("numTurns").toInt())
    }

    fun labels(detail: JsonObject): List<Label> = (detail["tags"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().mapNotNull { t ->
        Label(t.string("id") ?: return@mapNotNull null, t.string("name").orEmpty(), t.string("color"))
    }

    private fun map(value: JsonElement?): Map<String, String> =
        (value as? JsonObject).orEmpty().mapNotNull { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { k to it } }.toMap()

    // ---- Writes ----

    /** The whole session map, as PATCH replaces it; an empty one clears it. */
    fun envPatch(env: Map<String, String>) = buildJsonObject {
        if (env.isEmpty()) put("env", JsonNull) else putJsonObject("env") { env.toSortedMap().forEach { (k, v) -> put(k, v) } }
    }
    fun notifyPatch(needsYou: Boolean, value: Notify) = buildJsonObject { put(if (needsYou) "notifyNeedsYou" else "notifyTurnFinished", value.wire) }
    fun mutePatch(muted: Boolean) = buildJsonObject { put("muted", muted) }
    fun tagsBody(ids: List<String>) = buildJsonObject { putJsonArray("tagIds") { ids.forEach { add(it) } } }

    /** The session's variables with Compact at set to [size], or without it for Default (null). */
    fun withCompact(env: Map<String, String>, size: String?): Map<String, String> =
        if (size == null) env - COMPACT_VARIABLE else env + (COMPACT_VARIABLE to size)

    /** [env] with [key] set to [value], in place of [replacing] when a row was renamed. */
    fun withVariable(env: Map<String, String>, key: String, value: String, replacing: String? = null): Map<String, String> =
        (if (replacing != null) env - replacing else env) + (key.trim() to value)

    /** Why [key] cannot be a session variable, or null when it can: the server's own rules. */
    fun keyProblem(key: String): String? = when {
        key.isBlank() -> "Enter a name."
        !KEY.matches(key.trim()) -> "Use letters, digits and _, not starting with a digit."
        key.trim().uppercase().startsWith("ORBIT_") -> "ORBIT_ variables are Orbit's own."
        else -> null
    }

    /** The rows the Variables page lists as this session's: Compact at keeps its own. */
    fun sessionVariables(state: State) = (state.env - COMPACT_VARIABLE).toSortedMap()
    /** The workspace's, marked where a session variable of the same name replaces it. */
    fun workspaceVariables(state: State) = (state.workspaceEnv - COMPACT_VARIABLE).toSortedMap()

    // ---- What the rows say ----

    /** Compact at's value: the session's own size, else the workspace's, else Default. */
    fun compactLabel(state: State): String = compactSizeLabel(state.env[COMPACT_VARIABLE] ?: state.workspaceEnv[COMPACT_VARIABLE])
    fun compactSizeLabel(size: String?): String {
        val n = size?.trim()?.toLongOrNull() ?: return if (size.isNullOrBlank()) "Default" else "$size tokens"
        return if (n % 1000 == 0L) "${n / 1000}K tokens" else "$n tokens"
    }
    /** The single-choice dialog: Default (the workspace's size when it sets one), each offered size, and a typed one as it stands. */
    fun compactChoices(state: State): List<Pair<String?, String>> {
        val own = state.env[COMPACT_VARIABLE]
        val inherited = state.workspaceEnv[COMPACT_VARIABLE]
        val default = if (inherited == null) "Default" else "As the workspace (${compactSizeLabel(inherited)})"
        val sizes = (COMPACT_SIZES + listOfNotNull(own?.takeIf { it !in COMPACT_SIZES })).map { it to compactSizeLabel(it) }
        return listOf<Pair<String?, String>>(null to default) + sizes
    }

    fun variablesSummary(state: State): String {
        val own = sessionVariables(state).keys.toList()
        val inherited = workspaceVariables(state).keys.count { it !in own }
        val names = if (own.isEmpty()) "None for this session" else own.joinToString(", ")
        return if (inherited == 0) names else "$names · $inherited from the workspace"
    }

    const val RESTART_TITLE = "The new variables are waiting for the engine to restart."
    fun restartDetail(running: Boolean) = if (running) "A turn is running. Orbit restarts the engine with the new variables when it ends. The conversation is kept."
        else "Restart the engine to start using them. The conversation is kept."
    fun restartAction(running: Boolean) = if (running) "Restart after this turn" else "Restart"
    /** The 202's `afterTurn`, or the 409 that says the engine has already ended. */
    fun restartToast(afterTurn: Boolean) = if (afterTurn) "The engine restarts after this turn" else "Restarting the engine"
    const val ENGINE_ENDED = "The engine has ended. It uses the new variables when it next starts."

    /** 1.82M, 108K, 950. */
    fun tokens(n: Long): String = when {
        n >= 1_000_000 -> String.format(Locale.US, "%.2fM", n / 1_000_000.0).replace(Regex("\\.?0+M$"), "M")
        n >= 1_000 -> "${(n + 500) / 1000}K"
        else -> n.toString()
    }
    /** What the conversation read (fresh input and cache), wrote, and how much of what it read came from the cache. */
    fun tokensIn(u: Usage) = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens
    fun tokensTotal(u: Usage) = tokensIn(u) + u.outputTokens
    fun tokensLine(u: Usage) = "in ${tokens(tokensIn(u))} · out ${tokens(u.outputTokens)} · cache ${tokens(u.cacheReadTokens)}"
    fun cost(u: Usage) = String.format(Locale.US, "$%.2f", u.costUsd)
    fun turns(u: Usage) = if (u.numTurns == 1) "1 turn" else "${u.numTurns} turns"

    /** Claude Code 2.4.1 — the engine by its CLI's name, with the version the runner last reported. */
    fun engineLine(detail: JsonObject): String? {
        val engine = detail.string("engine") ?: return null
        return listOfNotNull(ProviderEngines.cliName(engine), detail.string("engineVersion")).joinToString(" ")
    }
    /** HPC · Default: the machine it runs on and the engine account it signed in with. */
    fun runnerAccount(detail: JsonObject): String? {
        val runner = (detail["assignedRunner"] as? JsonObject)?.let { it.string("displayName") ?: it.string("name") }
        val engine = detail.string("engine")
        val account = detail.string("account") ?: engine?.let { detail.string("${it}Account") }
        val accountLabel = account?.let { if (it == "default") "Default" else it }
        return listOfNotNull(runner, accountLabel).joinToString(" · ").ifEmpty { null }
    }
    fun branch(detail: JsonObject) = detail.string("worktreeBranch") ?: detail.string("branch")
    fun workingDirectory(detail: JsonObject) = (detail["workspace"] as? JsonObject)?.string("workDir")
    fun created(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? = iso?.let {
        runCatching { DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.US).format(Instant.parse(it).atZone(zone)) }.getOrNull()
    }
    /** …ac2e648c946c: the end of the id, which tells sessions apart (the last 12 hex digits). */
    fun shortId(id: String): String = (ObjectId.canonical(id) ?: id).replace("-", "").takeLast(12).let { "…$it" }
}

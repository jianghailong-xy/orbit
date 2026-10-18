package io.orbitd.android.composer

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * What the clients need to know about Cursor CLI (`cursor`) that no other engine shares, read the way the runner and the server read
 * it (docs/cursor-runtime-contract.md; the owner's design board docs/mocks/cursor-engine, whose iOS frames Android follows) — web
 * `lib/cursorRuntime.ts`, whose words these are.
 *
 * Orbit runs one pinned build of Cursor CLI (contract §1) and installs it itself, so a runner is asked whether it can START Cursor
 * CLI — it declares `provider:cursor` once that build is ready there, and its engine report says what is missing when it is not —
 * and, separately, whether the account a session would run on is signed in (`auth`, the CLI's own `agent models`).
 */
internal object CursorRuntime {
    /** The engine's own name, as a session's `engine` and a runner's engine report say it. */
    const val ENGINE = ProviderEngines.CURSOR
    /** Cursor CLI's name, as every list of engines writes it. */
    val CLI get() = ProviderEngines.cliName(ENGINE)
    /** The heartbeat capability the server requires before it hands out, resumes or leases a Cursor CLI session (contract §16.1):
     * declared only while the pinned build is ready on that runner. */
    const val RUNNER_CAPABILITY = "provider:cursor"
    /** What a runner declares once it signs a Cursor CLI account the control plane names into that account's own directory (contract
     * §16.1, P4b). Without it nothing offers to add one. */
    const val ACCOUNT_LOGIN_CAPABILITY = "cursor-account-login/v1"
    /** What a runner declares once it can carry a Cursor conversation to another account or key (contract §13.3, D5). No runner
     * declares it until two real identities have shown it works. */
    const val ACCOUNT_MOVE_CAPABILITY = "cursor-account-move/v1"
    /** The Cursor CLI build Orbit runs (contract §1): newer releases are not followed. */
    const val PINNED_VERSION = "2026.10.14-941492e"
    /** The preset a Cursor User API Key is connected from — not `cursor`, the engine's own name. */
    const val KEY_PRESET = "cursor-api"
    /** Where a Cursor key is connected, on the web. */
    const val CONNECT_PATH = "/providers/new/$KEY_PRESET"
    /** The runner's own variable that picks the account a session's CLI signs in with (@orbit/shared `ACCOUNT_DIR_VAR.cursor`). */
    const val ACCOUNT_DIR_VAR = "ORBIT_CURSOR_ACCOUNT_DIR"
    /** Auto's value in Cursor CLI's catalogue, with the parameterized model picker (contract §10). Naming no model runs it too. */
    const val AUTO_MODEL = "default"
    /** What a model menu or chip calls Auto while the runner has reported no catalogue to name it. */
    const val AUTO = "Auto"
    /** The permission modes Cursor CLI keeps (@orbit/shared `CURSOR_PERMISSION_MODES`): Default can't ask before an edit, so the
     * server refuses it (the owner's choice D6). */
    val PERMISSION_MODES = listOf("acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
    /** Where a session nobody named a mode for starts (@orbit/shared `CURSOR_DEFAULT_PERMISSION_MODE`). */
    const val DEFAULT_PERMISSION_MODE = "acceptEdits"

    /** What a mode's row says under it on Cursor CLI: @orbit/shared permissionSemantics' shortNote, first letter capitalised as the
     * board's subtitles are (iOS 6 ①②) — Default, which it refuses, and Don't Ask, which it enforces only in part. The others say none. */
    fun modeNote(mode: String): String? = when (mode) {
        "default" -> "Unsupported on $CLI; session configuration is rejected"
        "dontAsk" -> "Partly enforced, edits inside the workspace still run"
        else -> null
    }

    /** The mode a session falls back to when its own can't run on [engine]: Default, except on Cursor CLI, which has none and starts a
     * session in Accept Edits (web `fallbackPermissionMode`). */
    fun fallbackMode(engine: String) = if (engine == ENGINE) DEFAULT_PERMISSION_MODE else "default"

    // A runner

    /** Why a runner can't start Cursor CLI, most fundamental first, or [READY] — with the words a picker row or a machine's row says. */
    enum class RunnerState(val label: String?) {
        READY(null),
        UPDATE_RUNNER("Update runner"),
        UNSUPPORTED_PLATFORM("Not supported here"),
        UNSUPPORTED_VERSION("Unsupported version"),
        NOT_INSTALLED("Not installed");

        /** A state nothing signed in or read can change: the row's whole story ([NOT_INSTALLED] is every engine's missing CLI). */
        val blocksRow get() = this == UPDATE_RUNNER || this == UNSUPPORTED_PLATFORM || this == UNSUPPORTED_VERSION
    }

    /** The runner's own report of Cursor CLI, when it has one. */
    fun health(runner: JsonObject?): JsonObject? =
        (runner?.get("engines") as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { it.string("engine") == ENGINE }

    private fun declares(runner: JsonObject?, capability: String) =
        (runner?.get("capabilities") as? JsonArray)?.any { (it as? JsonPrimitive)?.contentOrNull == capability } == true

    /** Whether this runner knows Cursor CLI at all: it declares it, or reports it among its engines — every engine its release knows,
     * installed or not. A runner that does neither predates it. */
    fun knows(runner: JsonObject?): Boolean = declares(runner, RUNNER_CAPABILITY) || health(runner) != null

    /**
     * Whether this runner can start a Cursor CLI session, in the board's order of what is most fundamental: a runner that predates
     * Cursor CLI, then a platform the pinned build was never measured on, then a build other than the pinned one, then none at all. A
     * runner whose report says the pinned build is ready and still does not declare it carries no session driver for it, which an
     * update brings — the server refuses it a session either way. Signed in or not is the credential's question, not the runner's.
     */
    fun state(runner: JsonObject?): RunnerState {
        val health = health(runner)
        val declared = declares(runner, RUNNER_CAPABILITY)
        if (health == null) return if (declared) RunnerState.READY else RunnerState.UPDATE_RUNNER
        val error = health.string("installationError").orEmpty()
        if (error.startsWith("CURSOR_PLATFORM_UNSUPPORTED")) return RunnerState.UNSUPPORTED_PLATFORM
        if (error.startsWith("CURSOR_VERSION_INCOMPATIBLE")) return RunnerState.UNSUPPORTED_VERSION
        if ((health["installed"] as? JsonPrimitive)?.contentOrNull != "true") return RunnerState.NOT_INSTALLED
        return if (declared) RunnerState.READY else RunnerState.UPDATE_RUNNER
    }

    /** One sentence under a machine's Cursor CLI row on what the state means and what fixes it. Not installed has none: its row offers
     * the install itself. A platform the pinned build does not run on is the runner's own sentence, which names both platforms. */
    fun hint(state: RunnerState, health: JsonObject?): String? = when (state) {
        RunnerState.UPDATE_RUNNER -> "This runner predates $CLI. It updates itself when no session is running on it."
        RunnerState.UNSUPPORTED_VERSION ->
            "Orbit runs $CLI $PINNED_VERSION. Reinstall puts that version back on this runner; sessions here can’t start until then."
        RunnerState.UNSUPPORTED_PLATFORM -> {
            val said = health?.string("installationError").orEmpty().replace(Regex("^CURSOR_PLATFORM_UNSUPPORTED:\\s*"), "").trim()
            if (said.isNotEmpty()) "${said.trimEnd('.')}." else "Orbit doesn’t run $CLI on this runner’s platform yet."
        }
        else -> null
    }

    /** Whether Orbit can sign Cursor CLI in on this runner at all: one that signs an account — Default, or one "Add Account" adds — into
     * its own directory (contract §16.1–16.2, D4; a Linux runner today). The server hands no Cursor CLI sign-in to any other. */
    fun signsIn(runner: JsonObject?): Boolean = declares(runner, ACCOUNT_LOGIN_CAPABILITY)

    /** Whether this runner carries a Cursor conversation to another account or key. */
    fun movesConversations(runner: JsonObject?): Boolean = declares(runner, ACCOUNT_MOVE_CAPABILITY)

    // A session

    /**
     * Whether a Cursor CLI session has a conversation another account or key would have to continue: a turn of it settled, Cursor opened
     * its conversation (runtimeSessionId, reported right before the first prompt), or a turn is running now. The same question the server
     * asks before it moves one (P6b), so the Provider menu never offers a move the server refuses.
     */
    fun conversationStarted(session: JsonObject?): Boolean {
        session ?: return false
        val turns = (session["numTurns"] as? JsonPrimitive)?.let { it.intOrNull ?: it.doubleOrNull?.toInt() } ?: 0
        val status = session.string("status")
        return turns > 0 || !session.string("runtimeSessionId").isNullOrEmpty() || status == "RUNNING" ||
            (status == "AWAITING_INPUT" && (session["engineTurnActive"] as? JsonPrimitive)?.contentOrNull == "true")
    }

    /** Whether a session on [engine] may not move to another of its runner's accounts or keys (D5): it is Cursor CLI's, has talked, and
     * its runner can't carry the conversation. A draft has no conversation, and starts on any of them. */
    fun moveBlocked(engine: String, session: JsonObject?, runner: JsonObject?, draft: Boolean): Boolean =
        engine == ENGINE && !draft && conversationStarted(session) && !movesConversations(runner)

    /** Cursor CLI on Auto: its catalogue's `default`, or no model named at all, which runs as Auto. */
    fun onAuto(engine: String, model: String?): Boolean = engine == ENGINE && (model.isNullOrEmpty() || modelBase(model) == AUTO_MODEL)

    // A model's parameters (the coordinator's convention for the board's iOS 5 ③④, 2026-10-18)

    /** The parameters a session's Cursor model value carries beside its model — the context and the speed, each a parameter of the model
     * in the runner's catalogue (`parameters`). Its effort stays in the session's effort field, and Auto takes none. */
    const val CONTEXT = "context"
    const val FAST = "fast"

    /** The model a Cursor model value names, without the parameters it carries: `claude-opus-5-5[context=1m]` is `claude-opus-5-5`. */
    fun modelBase(model: String): String = model.substringBefore('[')

    /** The parameters a Cursor model value carries, in Cursor's own bracket notation (`claude-opus-5-5[context=1m,fast=true]`), by id. */
    fun modelParameters(model: String?): Map<String, String> {
        val inside = model?.substringAfter('[', "")?.removeSuffix("]").orEmpty()
        return inside.split(',').mapNotNull { pair -> pair.split('=', limit = 2).takeIf { it.size == 2 && it[0].isNotBlank() }?.let { it[0].trim() to it[1].trim() } }
            .toMap()
    }

    /** [base] carrying [parameters], in the catalogue's order of them: a value at the model's own default is left out, so a model on
     * every default is its bare name. */
    fun withParameters(base: String, parameters: Map<String, String>, row: JsonObject?): String {
        val order = parameters(row)
        val set = order.mapNotNull { parameter ->
            val id = parameter.string("id") ?: return@mapNotNull null
            parameters[id]?.takeIf { it != parameter.string("default") }?.let { "$id=$it" }
        }
        return if (set.isEmpty()) base else "$base[${set.joinToString(",")}]"
    }

    /** A catalogue row's parameters — `{id, label, category, default, values: [{value, label}]}` — as the runner reports them. */
    fun parameters(row: JsonObject?): List<JsonObject> = (row?.get("parameters") as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()

    /** One of a catalogue row's parameters, by its id: the context, the speed. */
    fun parameter(row: JsonObject?, id: String): JsonObject? = parameters(row).firstOrNull { it.string("id") == id }

    /** A parameter's value as its row names it: "1M", "Fast". */
    fun valueLabel(parameter: JsonObject, value: String): String =
        (parameter["values"] as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { it.string("value") == value }?.string("label") ?: value

    /** The values a parameter takes, in its row's order. */
    fun values(parameter: JsonObject): List<String> =
        (parameter["values"] as? JsonArray)?.filterIsInstance<JsonObject>()?.mapNotNull { it.string("value") }.orEmpty()

    /** What the model menu's Speed row calls the fast lane off and on (the board's Standard / Fast). */
    fun speedLabel(parameter: JsonObject, value: String) = if (value == "true") valueLabel(parameter, value) else "Standard"

    /** The model chip's words after the model's name (the board's "Opus 5.5 High · 1M · Fast"): a context the session set away from the
     * model's default, and Fast while the fast lane is on. */
    fun chipParameters(model: String?, row: JsonObject?): List<String> {
        val set = modelParameters(model)
        return listOfNotNull(
            parameter(row, CONTEXT)?.let { context -> set[CONTEXT]?.takeIf { it != context.string("default") }?.let { valueLabel(context, it) } },
            parameter(row, FAST)?.let { fast -> (set[FAST] ?: fast.string("default")).takeIf { it == "true" }?.let { valueLabel(fast, it) } },
        )
    }

    /** A session's Cursor model as the chip and the context sheet name it (the board's iOS 5 ①②④): Auto, or the catalogue's name for
     * the model with the effort set on it, then [chipParameters] — "Claude Opus 5.5 High · 1M · Fast". Never the bracketed value. */
    fun modelName(catalog: ComposerCatalog?, provider: String, model: String, effort: String?): String {
        if (onAuto(ENGINE, model)) return AUTO
        val row = catalog?.modelRow(ENGINE, provider, model)
        val name = row?.string("label") ?: modelBase(model)
        return (listOf(if (effort.isNullOrEmpty()) name else "$name ${effortLabel(effort)}") + chipParameters(model, row)).joinToString(" · ")
    }

    // Words, the web's (lib/cursorRuntime.ts)

    /** Under the Provider menu of a Cursor CLI session that has talked, on a runner that can't carry its conversation: why its other
     * accounts and keys are listed but can't be picked (D5). The server's refusal of the same request says the same in its own words. */
    val MOVE_BLOCKED_NOTE get() = "$CLI can’t carry a conversation to another account or key yet. Start a new session to use one of these."
    /** In the model menu under Auto, which has no parameters to set (contract §10): the board's words (iOS 5 ①), context among them now
     * that the menu has its row — the web, with none, leaves context out. */
    const val AUTO_NOTE = "Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set."
    /** Under the tray of messages waiting for a running Cursor CLI turn (contract §3.2: a prompt sent mid-turn cancels the turn, so
     * Orbit queues it). */
    val QUEUE_NOTE get() = "$CLI can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends."
    /** The composer's placeholder while a Cursor CLI turn runs. */
    val RUNNING_PLACEHOLDER get() = "Reply — it goes to $CLI when this turn ends…"
    /** The context reading's line: Cursor CLI never reports context use over ACP (contract §4.1). */
    val CONTEXT_UNAVAILABLE get() = "$CLI doesn’t report how much of the window a session has used, so there is no reading to show."
    const val CONTEXT_WINDOW = "Context window"
    const val UNAVAILABLE = "Unavailable"
    /** An account a turn met Cursor's usage limit on this period, in an account row's quota (web `accountChoices`). */
    const val SPENT = "Spent"

    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
}

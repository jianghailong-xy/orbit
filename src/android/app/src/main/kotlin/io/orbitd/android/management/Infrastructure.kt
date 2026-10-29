package io.orbitd.android.management

import io.orbitd.android.composer.CursorRuntime
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.core.cards.DshRuntime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * OrbitKit `Infrastructure` and `ProvidersOverview` (iOS 33e0e2e09, 5e75edbde): the Infrastructure page — where the account's agents run
 * and whose model quota they spend, the web's /infrastructure on one page, which Runners and Providers became. Top to bottom: what needs
 * a person, the machines, Add Runner, the account pools and the API keys.
 *
 * Needs you, at its top, is iOS's rules (the web drew it too until 2026-10-25), read from the same lists — the machines (GET runners) and
 * the pools, its own and the ones it is in — so nothing new is asked of the server.
 * Pure, so InfrastructureTest pins it to iOS's cases and InfrastructureCopyParityTest its words to the Swift source.
 */
internal object Infrastructure {
    // Words
    /** The page's name: the Settings row that opens it, and its title. */
    const val TITLE = "Machines & models"
    /** The page's line: under Settings' Machines & models row. */
    const val SUBTITLE = "Where your agents run, and whose model quota they spend."
    const val NEEDS_YOU = "Needs you"
    const val MACHINES = "Machines"
    const val MACHINES_DETAIL = "Subscriptions signed in here are spent only by sessions on that machine."
    const val DETAILS = "Details"
    const val MANAGE = "Manage"
    /** A key that is switched off — listed, and nothing runs on it. */
    const val DISABLED = "Disabled"
    const val ACCOUNT_POOLS = "Account pools"
    const val ACCOUNT_POOLS_DETAIL = "Several accounts under one name."
    const val API_KEYS = "API keys"
    const val API_KEYS_DETAIL = "On your account and usable from every machine — billed per token."
    const val NO_KEYS = "No keys yet"
    /** An engine's page, for an engine the machine lacks while its install runs. */
    const val INSTALLING = "Installing…"
    const val RETRY = "Retry"

    fun offlineLine(machine: String) = "$machine is offline"
    /** "Last seen 1d ago · its subscriptions are unavailable until it’s back". */
    fun offlineDetail(lastHeartbeatAt: String?, nowMs: Long) =
        (lastHeartbeatAt?.let { "Last seen ${RunnerPage.ago(it, nowMs)}" } ?: "Never checked in") + " · its subscriptions are unavailable until it’s back"
    fun poolLine(pool: String) = "$pool is unavailable"
    /** "No account can run · no session can start on it" — the pool's own reason first. */
    fun poolDetail(reason: String) = "$reason · no session can start on it"
    /** Install, on an engine's page, for an engine its machine lacks: "Install Kimi Code". */
    fun install(engine: String) = "Install ${ProviderEngines.cliName(engine)}"

    /** "3 machines · 7 / 12 slots busy", over the machines: the slots of those online. Null with none. */
    fun machinesCount(runners: List<JsonObject>): String? {
        if (runners.isEmpty()) return null
        val online = runners.filter { it.bool("online") == true }
        val busy = online.sumOf { it.int("activeSessions") ?: 0 }
        val all = online.sumOf { it.int("maxConcurrent") ?: 0 }
        return "${runners.size} machine${if (runners.size == 1) "" else "s"} · $busy / $all slots busy"
    }

    /** SettingsHome.infrastructureValue: "1 needs you" — how many lines Needs you holds; with none, how many of the account's machines
     * can take work right now. */
    fun settingsValue(needsYou: Int, runners: List<JsonObject>): String =
        if (needsYou > 0) { if (needsYou == 1) "1 needs you" else "$needsYou need you" } else settingsRunnersValue(runners)

    // Needs you

    /** Where a line of Needs you goes: a machine offline is its record; a pool no session can start on is its page — one of the
     * account's own, or one it is in. */
    sealed interface Kind {
        data class Offline(val runnerId: String) : Kind
        data class PoolUnavailable(val poolId: String, val own: Boolean) : Kind
    }

    /** One line of what waits on a person (web's NeedsAttention): "ThinkPad is offline", the names it sets in bold, and what it means
     * under it. */
    data class Attention(val kind: Kind, val line: String, val names: List<String>, val detail: String) {
        val id: String get() = when (kind) {
            is Kind.Offline -> "offline:${kind.runnerId}"
            is Kind.PoolUnavailable -> "pool:${kind.poolId}"
        }
    }

    /** What needs a person, a line each: each machine offline, then each pool no session can start on — the ones the account is in
     * before its own, as the page lists them. An engine signed out on a machine is no line, as the web's machine card draws it nothing:
     * the machine's own page says so, and signs it in (OrbitKit `Infrastructure.attention`). */
    fun attention(runners: List<JsonObject>, memberPools: List<Pool>, ownPools: List<Pool>, nowMs: Long): List<Attention> {
        val offline = runners.filter { it.bool("online") != true }.map { runner ->
            val machine = RunnerPage.displayName(runner)
            Attention(Kind.Offline(runner.text("id")), offlineLine(machine), listOf(machine), offlineDetail(runner.str("lastHeartbeatAt"), nowMs))
        }
        val unavailable = (memberPools.map { it to false } + ownPools.map { it to true }).mapNotNull { (pool, own) ->
            val reason = pool.unavailable ?: return@mapNotNull null
            Attention(Kind.PoolUnavailable(pool.id, own), poolLine(pool.label), listOf(pool.label), poolDetail(reason))
        }
        return offline + unavailable
    }

    // A key's model

    /** The model a session on this key starts on, by the name the key's own list gives it (web's defaultModelOf): its default, else its
     * first model. */
    fun defaultModel(key: JsonObject): String? {
        val models = key.list("models")
        val model = listOfNotNull(key.str("defaultModel"), models.firstOrNull()?.str("value")).firstOrNull { it.isNotEmpty() } ?: return null
        return models.firstOrNull { it.str("value") == model }?.str("label")?.takeIf { it.isNotEmpty() } ?: model
    }

    /** The model a Cursor CLI session on a Cursor key starts on (web's cursorModelOf): Auto, Cursor's own default, by the name the
     * catalogue of the first machine online that can run it gives it — the models are Cursor CLI's on each machine, whichever key it runs
     * on (docs/cursor-runtime-contract.md §10). Auto it is with none. A key's row and its page say it too (OrbitKit
     * `Infrastructure.cursorModel`). */
    fun cursorModel(online: List<JsonObject>): String {
        for (runner in online) {
            if (CursorRuntime.state(runner) != CursorRuntime.RunnerState.READY) continue
            val catalog = runner.obj("modelCatalog")?.list(ProviderEngines.CURSOR).orEmpty().takeIf { it.isNotEmpty() } ?: continue
            val model = runner.obj("runtimeDefaultModels")?.str(ProviderEngines.CURSOR)?.takeIf { it.isNotEmpty() } ?: CursorRuntime.AUTO_MODEL
            return catalog.firstOrNull { it.str("value") == model }?.str("label") ?: catalog[0].str("label") ?: CursorRuntime.AUTO
        }
        return CursorRuntime.AUTO
    }

    // A machine's row

    /** "2 / 4 running" — the slots taken on a machine that is online. */
    fun running(active: Int, max: Int) = "$active / $max running"

    /** A machine's line in the list: how many of its slots are taken while it is online and has a limit, then where its engines stand —
     * never a count of the ones signed out, which the web's card leaves to the machine's own page too. */
    fun machineLine(runner: JsonObject, nowMs: Long): String {
        val parts = mutableListOf<String>()
        val max = runner.int("maxConcurrent")
        if (runner.bool("online") == true && max != null && max > 0) parts += running(runner.int("activeSessions") ?: 0, max)
        parts += summary(runner, nowMs)
        return parts.joinToString(RunnerCopy.SEP)
    }

    /** A machine's engines in a few words (web's folded card, summaryOf): an install or update under way or failed, the engines not
     * keeping current while it is online, else how many of the engines the page lists are signed in. */
    fun summary(runner: JsonObject, nowMs: Long): String {
        val relay = runner.obj("install")
        val updating = relay?.str("mode") == "update"
        if (relay?.str("status") == "failed") return if (updating) "Update failed" else "Install failed"
        if (relay?.str("status") == "pending" || relay?.str("status") == "installing") return if (updating) "Updating…" else "Installing…"
        val reported = (runner["engines"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: return "Engines not reported"
        // Cursor CLI wherever its row can get it signed in, installed or not, as every engine here — not on a runner too old for it or a
        // platform it doesn't run on, whose row has nothing to sign in; nor where no runner shows it at all.
        val cursor = CursorRuntime.state(runner)
        val engines = RunnerPage.loginEngines.filter {
            (it != ProviderEngines.ANTIGRAVITY || runner.obj("antigravity")?.str("googleLogin") == "available") &&
                (it != ProviderEngines.CURSOR || (ProviderEngines.androidShowsEngine(it, listOf(runner)) &&
                    cursor != CursorRuntime.RunnerState.UPDATE_RUNNER && cursor != CursorRuntime.RunnerState.UNSUPPORTED_PLATFORM))
        }
        val shown = reported.filter { it.str("engine") in engines }
        val stale = shown.count { it.bool("installed") == true && RunnerPage.updateNoteOf(it.obj("update"), nowMs)?.first == "warn" }
        if (stale > 0 && runner.bool("online") == true) return if (stale == 1) "1 engine not updating" else "$stale engines not updating"
        val ready = shown.count(::signedIn)
        return if (ready == engines.size) "All signed in" else "$ready of ${engines.size} signed in"
    }

    /** Signed in, with every account of it too (web's signedIn): Antigravity's Default on the machine's own key runs, so it counts. */
    private fun signedIn(health: JsonObject) = health.bool("installed") == true && health.str("auth") == "yes" &&
        health.list("accounts").all { it.str("auth") == "yes" || RunnerPage.runsOnEnvKey(health, it.text("id"), it.str("auth")) }

    // One engine on one machine

    /** Where one engine's row stands on a machine (web's RowKind). UNKNOWN: the CLI wouldn't say — never drawn as signed in. INSTALLED:
     * installed, before the machine's next check-in says so itself. */
    enum class RowKind { SIGNED_IN, SIGNED_OUT, UNKNOWN, MISSING, INSTALLING, INSTALLED, INSTALL_FAILED }

    /** One engine on one machine as its row reads it (web's engineHealthOf): the runner's own report — for Antigravity with its install
     * and credential taken from the server's answer (`runner.antigravity`) once it has one. */
    fun engineHealth(runner: JsonObject, engine: String): JsonObject? {
        val reported = runner.list("engines").firstOrNull { it.str("engine") == engine }
        val state = runner.obj("antigravity")
        val installed = state?.bool("installed")
        if (engine != ProviderEngines.ANTIGRAVITY || state == null || installed == null) return reported
        return buildJsonObject {
            reported?.forEach { (name, value) -> put(name, value) }
            put("engine", engine)
            put("installed", installed)
            (state.str("version") ?: reported?.str("version"))?.let { put("version", it) }
            put("auth", reported?.str("auth") ?: if (state.bool("envKeyAvailable") == true) "yes" else "unknown")
            (state.str("authSource") ?: reported?.str("authSource"))?.let { put("authSource", it) }
        }
    }

    /** What an engine's row says (web's rowKindOf): an install of it in flight, or one that ended before the machine's probe answered for
     * itself, outranks the probe; then whether it is there and signed in. */
    fun rowKind(health: JsonObject?, install: JsonObject?, engine: String): RowKind {
        if (install != null && install.str("engine") == engine) {
            val status = install.str("status")
            if (status == "pending" || status == "installing") return RowKind.INSTALLING
            if (status == "failed" && health?.bool("installed") != true) return RowKind.INSTALL_FAILED
            if (status == "done" && health?.bool("installed") != true) return RowKind.INSTALLED
        }
        if (health?.bool("installed") != true) return RowKind.MISSING
        return when (health.str("auth")) { "yes" -> RowKind.SIGNED_IN; "no" -> RowKind.SIGNED_OUT; else -> RowKind.UNKNOWN }
    }

    /** Whether an engine's page offers to install it on this machine (web's Install and Retry on its row): one the machine doesn't have,
     * or whose last install failed — Antigravity only on a runner that can run it. */
    fun installable(runner: JsonObject, engine: String): Boolean {
        if (engine == ProviderEngines.ANTIGRAVITY && runner.obj("antigravity")?.bool("supported") == false) return false
        return rowKind(engineHealth(runner, engine), runner.obj("install"), engine).let { it == RowKind.MISSING || it == RowKind.INSTALL_FAILED }
    }

    /** Whether OpenCode's page offers to install it (web's OpenCode row): it signs in per provider, on the machine, so its install is the
     * one press its page has — on a machine that reports it missing, or whose last install of it failed. A runner that never mentions
     * OpenCode gets none, as the web draws it no row. */
    /** Whether an engine the machine lacks has its page to open from the machine's record (web's Install on its row): that page installs
     * it — Install, or Retry after an install that failed — or shows the install running. DeepSeek Harness's page installs its pinned CLI
     * where the machine can run one (OrbitKit `Infrastructure.installsFromPage`). */
    fun installsFromPage(runner: JsonObject, engine: String): Boolean {
        if (engine == ProviderEngines.DSH) return DshRuntime.state(runner).installable || runner.obj("install")?.str("engine") == ProviderEngines.DSH
        val health = runner.list("engines").firstOrNull { it.str("engine") == engine }
        if (rowKind(health, runner.obj("install"), engine) == RowKind.INSTALLING) return true
        if (engine == ProviderEngines.OPENCODE) return installsOpenCode(runner)
        return RunnerPage.isLoginEngine(engine) && installable(runner, engine)
    }
    fun installsOpenCode(runner: JsonObject): Boolean {
        val health = runner.list("engines").firstOrNull { it.str("engine") == ProviderEngines.OPENCODE } ?: return false
        return rowKind(health, runner.obj("install"), ProviderEngines.OPENCODE).let { it == RowKind.MISSING || it == RowKind.INSTALL_FAILED }
    }
}

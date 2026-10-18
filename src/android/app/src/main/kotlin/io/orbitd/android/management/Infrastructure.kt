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
 * a person, what each engine can run on now, the machines, Add Runner, the account pools and the API keys.
 *
 * The two blocks at its top are the web's own rules (InfrastructureOverview.tsx), read from the same lists — the machines (GET runners),
 * the account's own keys (GET providers/mine) and its pools, its own and the ones it is in — so nothing new is asked of the server.
 * Pure, so InfrastructureTest pins it to iOS's cases and InfrastructureCopyParityTest its words to the Swift source.
 */
internal object Infrastructure {
    // Words
    /** The page's name: the Settings row that opens it, and its title. */
    const val TITLE = "Infrastructure"
    /** The page's line: under Settings' Machines & models row. */
    const val SUBTITLE = "Where your agents run, and whose model quota they spend."
    const val NEEDS_YOU = "Needs you"
    const val ENGINES_TITLE = "What your agents can run on"
    const val ENGINES_DETAIL = "Every engine, and everything that can pay for it right now."
    const val MACHINES = "Machines"
    const val MACHINES_DETAIL = "Subscriptions signed in here are spent only by sessions on that machine."
    const val READY = "Ready"
    const val NOT_SET_UP = "Not set up"
    const val SUBSCRIPTION = "Subscription"
    /** OpenCode's sign-in on a machine, which is its own rather than a subscription's. */
    const val OWN_SIGN_IN = "Own sign-in"
    const val API_KEY = "API key"
    const val POOL = "Pool"
    /** An engine nothing can pay for. The web goes on to offer a key too; adding a key happens on the web. */
    const val NOTHING_CAN_PAY = "No machine signed in, no key."
    const val INSTALL_ON_A_MACHINE = "Install on a machine"
    const val SIGN_IN = "Sign in"
    const val DETAILS = "Details"
    const val MANAGE = "Manage"
    /** A key that is switched off — listed, and nothing runs on it. */
    const val DISABLED = "Disabled"
    const val SIGNED_OUT_DETAIL = "Sessions there can’t use it"
    const val ACCOUNT_POOLS = "Account pools"
    const val ACCOUNT_POOLS_DETAIL = "Several accounts under one name."
    const val API_KEYS = "API keys"
    const val API_KEYS_DETAIL = "On your account and usable from every machine — billed per token."
    const val NO_KEYS = "No keys yet"
    /** An engine's page, for an engine the machine lacks while its install runs. */
    const val INSTALLING = "Installing…"
    const val RETRY = "Retry"

    /** "Antigravity CLI is signed out on HPC": the engine by its CLI's name, as every list on the page names it. */
    fun signedOutLine(engine: String, machine: String) = "${ProviderEngines.cliName(engine)} is signed out on $machine"
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

    /** Where a line of Needs you goes: an engine signed out on a machine online is signed in again on its page; a machine offline is
     * its record; a pool no session can start on is its page — one of the account's own, or one it is in. */
    sealed interface Kind {
        data class SignedOut(val runnerId: String, val engine: String) : Kind
        data class Offline(val runnerId: String) : Kind
        data class PoolUnavailable(val poolId: String, val own: Boolean) : Kind
    }

    /** One line of what waits on a person (web's NeedsAttention): "Codex is signed out on Mac Studio", the names it sets in bold, and
     * what it means under it. */
    data class Attention(val kind: Kind, val line: String, val names: List<String>, val detail: String) {
        val id: String get() = when (kind) {
            is Kind.SignedOut -> "out:${kind.runnerId}/${kind.engine}"
            is Kind.Offline -> "offline:${kind.runnerId}"
            is Kind.PoolUnavailable -> "pool:${kind.poolId}"
        }
    }

    /** What needs a person, a line each, in the web's order: each engine signed out on a machine that is online, each machine offline,
     * then each pool no session can start on — the ones the account is in before its own, as the page lists them. */
    fun attention(runners: List<JsonObject>, memberPools: List<Pool>, ownPools: List<Pool>, nowMs: Long): List<Attention> {
        val signedOut = runners.flatMap { runner ->
            val machine = RunnerPage.displayName(runner)
            signedOutEngines(runner).map { engine ->
                Attention(Kind.SignedOut(runner.text("id"), engine), signedOutLine(engine, machine), listOf(ProviderEngines.cliName(engine), machine),
                    SIGNED_OUT_DETAIL)
            }
        }
        val offline = runners.filter { it.bool("online") != true }.map { runner ->
            val machine = RunnerPage.displayName(runner)
            Attention(Kind.Offline(runner.text("id")), offlineLine(machine), listOf(machine), offlineDetail(runner.str("lastHeartbeatAt"), nowMs))
        }
        val unavailable = (memberPools.map { it to false } + ownPools.map { it to true }).mapNotNull { (pool, own) ->
            val reason = pool.unavailable ?: return@mapNotNull null
            Attention(Kind.PoolUnavailable(pool.id, own), poolLine(pool.label), listOf(pool.label), poolDetail(reason))
        }
        return signedOut + offline + unavailable
    }

    /** The engines signed out on a machine that is online — the ones Needs you lists for it, so a machine's row and that list never
     * disagree. None for a machine offline: its line says so instead. */
    fun signedOutEngines(runner: JsonObject): List<String> =
        if (runner.bool("online") != true) emptyList() else RunnerPage.loginEngines.filter { signedOut(runner, it) }

    /** Whether this engine is signed out on this machine (web's signedOutOn): installed, the CLI's own answer is no, and no account of it
     * is signed in either — with one that is, sessions there still run on it. Antigravity only where its Google sign-in can be started,
     * the one way back in there is; Cursor CLI only where the machine can run it, which signing in would not change. */
    private fun signedOut(runner: JsonObject, engine: String): Boolean {
        val health = engineHealth(runner, engine)
        if (rowKind(health, runner.obj("install"), engine) != RowKind.SIGNED_OUT) return false
        val antigravity = runner.obj("antigravity")
        if (engine == ProviderEngines.ANTIGRAVITY && (antigravity?.bool("supported") == false || antigravity?.str("googleLogin") != "available")) return false
        if (engine == ProviderEngines.CURSOR && CursorRuntime.state(runner) != CursorRuntime.RunnerState.READY) return false
        return health?.list("accounts").orEmpty().none { it.str("auth") == "yes" }
    }

    // What each engine can run on

    /** One engine and what can pay for it now (web's EngineOverview card), for every engine a session can run on. */
    data class EngineCard(val engine: String, val machines: List<String>, val keys: List<Key>, val pools: List<String>) {
        /** A key that runs on the engine, and the model a session on it starts on there. */
        data class Key(val label: String, val model: String?)
        /** Its CLI's own name: "Antigravity CLI". */
        val name get() = ProviderEngines.cliName(engine)
        /** What its machines are: OpenCode's own sign-in, every other engine's subscription. */
        val machinesLabel get() = if (engine == ProviderEngines.OPENCODE) OWN_SIGN_IN else SUBSCRIPTION
        /** Ready with any source at all; Not set up without. */
        val ready get() = machines.isNotEmpty() || keys.isNotEmpty() || pools.isNotEmpty()
    }

    /** Every engine, and what can pay for it now: the machines online signed in to it, by how many of their accounts ("Mac Studio ×2");
     * each enabled key under every engine the server says it runs on (`engines`), with the model a session on it starts on there; its
     * pools that can start a session (one that is unavailable is in Needs you instead). Cursor CLI once a machine of the account knows it
     * (ProviderEngines.androidShowsEngine). */
    fun engineCards(runners: List<JsonObject>, keys: List<JsonObject>, pools: List<Pool>): List<EngineCard> {
        val online = runners.filter { it.bool("online") == true }
        val harness = harnessModel(online)
        val cursor = cursorModel(online)
        return ProviderEngines.ALL_ENGINES.filter { ProviderEngines.androidShowsEngine(it, runners) }.map { engine ->
            // DeepSeek Harness has no sign-in on a machine: it runs on DeepSeek keys alone.
            val machines = if (engine == ProviderEngines.DSH) emptyList() else online.mapNotNull { runner ->
                val count = logins(runner, engine)
                if (count <= 0) null else RunnerPage.displayName(runner).let { if (count > 1) "$it ×$count" else it }
            }
            val engineKeys = keys.filter { it.bool("enabled") != false && engine in KeyEngines.engines(it) }.map {
                EngineCard.Key(it.str("label") ?: it.text("slug"), when (engine) {
                    ProviderEngines.DSH -> harness
                    ProviderEngines.CURSOR -> cursor
                    else -> defaultModel(it)
                })
            }
            val enginePools = pools.filter { it.unavailable == null && (if (ProviderPools.runsCodex(it)) ProviderEngines.CODEX else ProviderEngines.CLAUDE) == engine }
            EngineCard(engine, machines, engineKeys, enginePools.map { it.label })
        }
    }

    /** The machine Install on a machine opens, on that engine's page: the first one online, as the web's does. Null with none online —
     * the way to one is registering a machine. */
    fun installTarget(runners: List<JsonObject>): JsonObject? = runners.firstOrNull { it.bool("online") == true }

    /** How many logins of this engine a session on this machine can run on (web's loginsOn): each account signed in, or the engine's own
     * answer where it reports no accounts — for OpenCode, whether its own sign-in is set up there. Antigravity's Default on the machine's
     * own Gemini key counts, as it does on the machine's page. */
    fun logins(runner: JsonObject, engine: String): Int {
        val health = engineHealth(runner, engine) ?: return 0
        if (health.bool("installed") != true) return 0
        if (engine == ProviderEngines.ANTIGRAVITY && runner.obj("antigravity")?.bool("supported") == false) return 0
        if (engine == ProviderEngines.CURSOR && CursorRuntime.state(runner) != CursorRuntime.RunnerState.READY) return 0
        val accounts = health.list("accounts")
        if (accounts.isEmpty()) return if (health.str("auth") == "yes") 1 else 0
        return accounts.count { it.str("auth") == "yes" || RunnerPage.runsOnEnvKey(health, it.text("id"), it.str("auth")) }
    }

    /** The model a session on this key starts on, by the name the key's own list gives it (web's defaultModelOf): its default, else its
     * first model. */
    fun defaultModel(key: JsonObject): String? {
        val models = key.list("models")
        val model = listOfNotNull(key.str("defaultModel"), models.firstOrNull()?.str("value")).firstOrNull { it.isNotEmpty() } ?: return null
        return models.firstOrNull { it.str("value") == model }?.str("label")?.takeIf { it.isNotEmpty() } ?: model
    }

    /** The model a DeepSeek Harness session starts on, by the name its catalogue gives it (web's harnessModelOf): not a key's own —
     * Harness lists its models on each machine, whichever DeepSeek key it runs on — read off the first machine online that can run it and
     * has reported them; with none, no name. */
    private fun harnessModel(online: List<JsonObject>): String? {
        for (runner in online) {
            if (DshRuntime.state(runner) != DshRuntime.RunnerState.READY) continue
            val catalog = runner.obj("modelCatalog")?.list(ProviderEngines.DSH).orEmpty().takeIf { it.isNotEmpty() } ?: continue
            val model = runner.obj("runtimeDefaultModels")?.str(ProviderEngines.DSH)
            return catalog.firstOrNull { it.str("value") == model }?.str("label") ?: catalog[0].str("label")
        }
        return null
    }

    /** The model a Cursor CLI session on a Cursor key starts on (web's cursorModelOf): Auto, Cursor's own default, by the name the
     * catalogue of the first machine online that can run it gives it — the models are Cursor CLI's on each machine, whichever key it runs
     * on (docs/cursor-runtime-contract.md §10). Auto it is with none. */
    private fun cursorModel(online: List<JsonObject>): String {
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
    fun signedOutCount(count: Int) = if (count == 1) "1 engine signed out" else "$count engines signed out"

    /** A machine's line in the list: how many of its slots are taken while it is online and has a limit, then how many of its engines are
     * signed out — Needs you's rule — or, with none, where its engines stand. */
    fun machineLine(runner: JsonObject, nowMs: Long): String {
        val parts = mutableListOf<String>()
        val max = runner.int("maxConcurrent")
        if (runner.bool("online") == true && max != null && max > 0) parts += running(runner.int("activeSessions") ?: 0, max)
        val out = signedOutEngines(runner).size
        parts += if (out > 0) signedOutCount(out) else summary(runner, nowMs)
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
    fun installsOpenCode(runner: JsonObject): Boolean {
        val health = runner.list("engines").firstOrNull { it.str("engine") == ProviderEngines.OPENCODE } ?: return false
        return rowKind(health, runner.obj("install"), ProviderEngines.OPENCODE).let { it == RowKind.MISSING || it == RowKind.INSTALL_FAILED }
    }
}

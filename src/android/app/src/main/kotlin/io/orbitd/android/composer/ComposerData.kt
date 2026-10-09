package io.orbitd.android.composer

import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.management.AccountCopy
import io.orbitd.android.management.EngineAccounts
import io.orbitd.android.management.ProviderPools
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.UsageRow
import io.orbitd.android.management.accountSnapshot
import io.orbitd.android.management.bindingRow
import io.orbitd.android.management.usageRows
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import io.orbitd.android.navigation.ObjectId

internal fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.flag(key: String) = (get(key) as? JsonPrimitive)?.booleanOrNull
internal fun JsonObject.objects(key: String) = (get(key) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
internal fun JsonObject.strings(key: String) = (get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }

@Serializable
data class StagedAttachment(val id: String, val name: String, val mime: String, val size: Int = 0,
    val uri: String? = null, val source: String = "file", val remoteId: String? = null)

/** Written BEFORE a POST. Endpoint and body are immutable across lost responses and cold starts. */
@Serializable
data class PendingSend(val clientTurnId: String, val endpoint: String, val body: JsonObject,
    val text: String, val attachments: List<StagedAttachment> = emptyList())

@Serializable
data class ComposerDraft(val text: String = "", val selectionStart: Int = 0, val selectionEnd: Int = 0,
    val attachments: List<StagedAttachment> = emptyList(), val pending: PendingSend? = null,
    val resumeConfig: JsonObject = JsonObject(emptyMap()), val createdSessionId: String? = null)

data class DraftTarget(val workspaceId: String, val folderId: String? = null) {
    val key get() = "new-session:${ObjectId.canonical(workspaceId) ?: workspaceId}:${folderId?.let(ObjectId::canonical) ?: folderId.orEmpty()}"
}

data class ComposerState(val draft: ComposerDraft = ComposerDraft(), val loaded: Boolean = false,
    val busy: Boolean = false, val waiting: Boolean = false, val error: String? = null,
    val notice: String? = null, val uploads: Map<String, Float> = emptyMap(),
    val failures: Map<String, String> = emptyMap(), val catalog: ComposerCatalog? = null,
    val catalogLoading: Boolean = false, val catalogError: String? = null,
    val acknowledgementPending: Boolean = false)

/** Where a credential comes from, as the Provider menu groups it (docs/provider-engine-contract.md §1.3): the engine's own
 * sign-in on the runner, OpenCode's own configuration there, an account pool, or one of the user's keys. */
enum class CredentialKind { LOGIN, OPENCODE, POOL, KEY }

/** One credential an engine can run on, as the Provider menu lists it under that engine (web `ProviderChoice`). A key is a
 * choice under every engine that runs it; picking one never changes the engine. [detail] is what a sign-in is, in small type
 * beside it (`opencode auth`). */
data class ProviderOption(val id: String, val label: String, val kind: CredentialKind,
    val models: List<JsonObject>, val unavailable: String? = null, val detail: String? = null)

/** An engine as the new session's Engine list shows it (web `EngineChoice`): every credential it runs on here, and the one a pick
 * of it lands on — none for DeepSeek Harness before a DeepSeek key is connected, whose row offers the connection instead. */
data class EngineOption(val engine: String, val providers: List<ProviderOption>, val landing: ProviderOption?,
    val unavailable: String? = null) {
    val label get() = ProviderEngines.cliName(engine)
}

/** The words the engine and provider pickers share across the composer and a task's pins (boards 4–6). */
object EngineCopy {
    const val ENGINE = "Engine"
    const val ENGINE_FOOTER = "Pick the provider and account in the composer's model menu."
    const val CONNECT_DEEPSEEK_KEY = "Connect a DeepSeek key"
    /** Where a DeepSeek key is connected: the web's connect page for the DeepSeek preset. */
    const val DEEPSEEK_CONNECT_PATH = "/providers/new/deepseek"
    const val PROVIDER = "Provider"
    const val ACCOUNT_POOLS = "Account pools"
    const val API_KEYS = "API keys"
    const val THIS_SESSIONS_KEY = "This session's key"
    const val KEY_DELETED = "Key deleted"
    const val TURNED_OFF = "Turned off"
    const val AUTOMATIC = "Automatic"
    const val AUTOMATIC_DETAIL = "Switches to soonest reset"
    const val DEFAULT = "Default"
    const val OPENCODE_OWN = "OpenCode's own sign-in"
    const val OPENCODE_OWN_DETAIL = "opencode auth"
    const val WORKSPACE_KEY = "Workspace key"
    const val ASSIGNEES = "Assignee's"
    const val ENGINE_DEFAULT = "Engine default"
    const val YOUR_KEYS = "Your keys"
    const val YOUR_DEEPSEEK_KEYS = "Your DeepSeek keys"
    const val FIRST_DEEPSEEK_KEY = "first DeepSeek key"
    const val RUNNER_SIGN_IN = "runner sign-in"
    const val OWN_SIGN_IN = "own sign-in"
    fun signedInOn(runner: String) = "Signed in on $runner"
    fun on(runner: String) = "On $runner"
    fun signInOn(runner: String) = "sign-in on $runner"
    /** A Claude subscription token is the one key on Anthropic's protocol OpenCode does not run: its absence there is said. */
    fun subscriptionOnly(labels: List<String>) =
        "${labels.joinToString(", ")} ${if (labels.size == 1) "isn’t" else "aren’t"} here: a subscription token runs on Claude Code only."
}

/** One of the runner's accounts of an engine as a row of the account menu (web AccountChoice): its own quota's tightest
 * window, compactly ("5h 12%", an Antigravity bucket by what is left: "gemini-5h 4% left"), "env key" for an Antigravity
 * Default on the runner's own Gemini key, and why it can't take a session. */
data class AccountChoice(val id: String, val label: String, val quota: String? = null, val nearLimit: Boolean = false,
    val unavailable: String? = null)

/**
 * What the composer's pickers judge by: the runner a session runs on (its engines, accounts, model catalogue and quotas) and the
 * account's keys and pools ([providers]: GET /providers with each key's `engines`, and the pools read as providers). [own] is the
 * account's own keys turned off included (GET /providers/mine), read only when a session's key is no longer listed: it tells a
 * key turned off from one deleted. Everything here is asked of an engine — the session's, fixed for its life — and of a credential
 * that engine runs (docs/provider-engine-contract.md §2).
 */
data class ComposerCatalog(val runner: JsonObject, val providers: List<JsonObject>, val own: List<JsonObject>? = null) {
    /** The key or pool [provider] names. An engine's own sign-in and OpenCode's own config never match one. */
    fun row(provider: String?): JsonObject? = provider?.takeIf { it !in ProviderEngines.LOGIN_ENGINES && it != ProviderEngines.OPENCODE }
        ?.let { slug -> providers.firstOrNull { it.text("slug") == slug } }
    private fun isPool(row: JsonObject) = row.flag("pool") == true || row["members"] is JsonArray
    fun providerEngines(provider: String?) = ProviderEngines.providerEngines(provider, providers)

    /** The engine [detail] runs on: a session's recorded engine; a draft's pick; else a workspace's last (`lastEngine`) where it
     * runs the provider beside it; else that provider's default engine (contract §1.1, §3.4). */
    fun engineOf(detail: JsonObject): String {
        detail.text("engine")?.takeIf(ProviderEngines::isEngine)?.let { return it }
        val runs = providerEngines(detail.text("provider"))
        detail.text("lastEngine")?.takeIf { ProviderEngines.isEngine(it) && (runs.isEmpty() || it in runs) }?.let { return it }
        return runs.firstOrNull() ?: ProviderEngines.CLAUDE
    }

    private fun health(engine: String) = runner.objects("engines").firstOrNull { it.text("engine") == engine }
    private fun catalogRows(engine: String) = ((runner["modelCatalog"] as? JsonObject)?.get(engine) as? JsonArray)?.filterIsInstance<JsonObject>()

    fun usage(detail: JsonObject): JsonObject? {
        val provider = detail.text("provider") ?: return null
        if (provider == ProviderEngines.OPENCODE) return null
        // Antigravity's quota travels with its engine health, each Google account's its own; Default's too, which a Default
        // on the machine's Gemini key has none of.
        if (provider == "antigravity") {
            val account = detail.text("account") ?: detail.text("antigravityAccount") ?: EngineAccounts.DEFAULT
            if (account == EngineAccounts.AUTOMATIC) return null
            return accountSnapshot(EngineAccounts.usage(provider, runner), account)
        }
        if (provider !in ProviderEngines.LOGIN_ENGINES) {
            val row = providers.firstOrNull { it.text("slug") == provider } ?: return null
            if (row["members"] is JsonArray) {
                val assigned = detail.text("poolMemberProviderId")
                val member = if (assigned != null) row.objects("members").firstOrNull { ObjectId.same(it.text("id"), assigned) }
                    else row.objects("members").firstOrNull { it.flag("next") == true }
                return member?.get("planUsage") as? JsonObject
            }
            return row["planUsage"] as? JsonObject // Never borrow a runner login's quota for a key.
        }
        val all = runner["planUsage"] as? JsonObject ?: return null
        val snapshot = all[provider] as? JsonObject ?: when (provider) {
            "codex" -> all.takeIf { it.text("provider") == "codex" || it["primary"] is JsonObject || it["secondary"] is JsonObject || it.objects("rateLimits").isNotEmpty() }
            "claude" -> all.takeIf { it.text("provider") in listOf(null, "claude") }
            "kimi" -> all.takeIf { it.text("provider") == "kimi" }
            else -> null
        } ?: return null
        val account = detail.text("account") ?: detail.text("${provider}Account") ?: "default"
        if (account == "automatic") return null // The server has not yet chosen the billed account.
        return if (account == "default") snapshot else (snapshot["accounts"] as? JsonObject)?.get(account) as? JsonObject
    }

    /** The runner's slash commands and skills for a session on [engine] (web `slashAssetMatchesEngine`): asked of the engine, never of
     * the provider — a DeepSeek key on Claude Code has Claude Code's. Codex, OpenCode, Antigravity and DeepSeek Harness take none. */
    fun slashItems(engine: String, agentId: String?): List<JsonObject> =
        (runner.objects("commands") + runner.objects("skills")).filter { item ->
            (item.text("agentId").isNullOrEmpty() || item.text("agentId") == agentId) && when (engine) {
                ProviderEngines.CODEX, ProviderEngines.OPENCODE, ProviderEngines.ANTIGRAVITY, ProviderEngines.DSH -> false
                ProviderEngines.KIMI -> item.text("provider") == "kimi"
                else -> item.text("provider") in listOf(null, "claude")
            }
        }.sortedWith(compareBy({ it.flag("builtin") == true }, { it.text("name")?.lowercase() }))

    /**
     * The models a session on [engine] with [provider] can pick: the model space is the pair's (contract §2.2). DeepSeek Harness
     * takes the runner's ACP catalogue whichever DeepSeek key it spends; a key brings its own table to every engine that runs it —
     * the runner's catalogue of its own endpoint's CLI where it opts in (`modelsFromRuntime`, read under that CLI's engine, never the
     * slug); an engine's own sign-in, and OpenCode's own config, the runner's catalogue of that CLI.
     */
    fun models(engine: String, provider: String): List<JsonObject> {
        if (engine == ProviderEngines.DSH) return catalogRows(ProviderEngines.DSH).orEmpty()
        val row = row(provider)
        if (row != null) {
            val live = if (row.flag("modelsFromRuntime") == true && row.text("runtime") != ProviderEngines.DSH)
                catalogRows(ProviderEngines.nativeEngine(row.text("runtime"))) else null
            return live ?: row.objects("models")
        }
        return catalogRows(engine).orEmpty()
    }

    /** The model a session on [engine] with [provider] runs when nothing names one — the same pair-wise space as [models]; "" lets
     * the runtime pick (OpenCode always, DeepSeek Harness until a runner reports its catalogue). */
    fun defaultModel(engine: String, provider: String): String {
        val defaults = runner["runtimeDefaultModels"] as? JsonObject
        fun reported(engine: String) = defaults?.text(engine)?.takeIf { it.isNotEmpty() }
        val first = models(engine, provider).firstOrNull()?.text("value")
        val row = row(provider)
        return when {
            engine == ProviderEngines.DSH -> reported(ProviderEngines.DSH) ?: first
            row != null -> if (row.flag("modelsFromRuntime") == true && row.text("runtime") != ProviderEngines.DSH)
                reported(ProviderEngines.nativeEngine(row.text("runtime"))) ?: first
                else row.text("defaultModel")?.takeIf { it.isNotEmpty() } ?: first
            engine == ProviderEngines.OPENCODE -> reported(ProviderEngines.OPENCODE)
            else -> reported(engine) ?: first
        }.orEmpty()
    }

    /** A model as its row names it, or the id itself; an empty one is the runtime's own pick. */
    fun modelLabel(engine: String, provider: String, model: String): String =
        models(engine, provider).firstOrNull { it.text("value") == model }?.let { it.text("label") ?: model }
            ?: model.ifEmpty { if (engine == ProviderEngines.OPENCODE) "Managed by OpenCode" else "Runtime default" }

    /** Whether this runner can start a DeepSeek Harness session, as the server admits one (web `dshRunnerState`): null when it can,
     * else why not, most fundamental first. A runner that has not reported Harness claims nothing. */
    fun dshBlocker(): String? {
        if ("provider:dsh" !in runner.strings("capabilities")) return "Update runner"
        val health = health(ProviderEngines.DSH) ?: return null
        if (Regex("^DSH_(PLATFORM|NODE)_UNSUPPORTED").containsMatchIn(health.text("installationError").orEmpty())) return "Not supported here"
        if (health.flag("installed") != true) return RunnerCopy.NOT_INSTALLED
        if ((health["dsh"] as? JsonObject)?.let { it.flag("versionCompatible") != true } == true) return "Unsupported version"
        return null
    }

    /**
     * The credentials [engine] can run on, in the Provider menu's order (web `engineProviders`): the engine's own sign-in on the
     * runner — or OpenCode's own configuration — then the account pools that run on it, then every key it runs, as GET /providers
     * returned them. DeepSeek Harness has no sign-in: its credentials are the account's DeepSeek keys, every one of them.
     *
     * Each carries why this runner can't run it — the engine's CLI missing, its sign-in signed out, a pool none of whose accounts can
     * run — and stays listed: a hidden row would leave nobody able to tell why it isn't offered. A runner that has reported no
     * engines claims nothing, so its sign-ins are listed as they are; one that has lists the sign-ins it reports.
     */
    fun credentials(engine: String): List<ProviderOption> {
        val health = health(engine)
        val reportsEngines = runner["engines"] is JsonArray
        // What a credential that brings its own key needs from this runner: the engine's CLI, and for Harness what the server
        // admits it on.
        val carried = if (engine == ProviderEngines.DSH) dshBlocker() else if (health?.flag("installed") == false) RunnerCopy.NOT_INSTALLED else null
        val own = buildList {
            if (engine in ProviderEngines.LOGIN_ENGINES && (health != null || !reportsEngines)) {
                val signedOut = health?.text("auth") == "no" && health.objects("accounts").none { it.text("auth") == "yes" }
                add(ProviderOption(engine, signInLabel(engine), CredentialKind.LOGIN, models(engine, engine),
                    carried ?: if (signedOut) "Not signed in" else null))
            }
            if (engine == ProviderEngines.OPENCODE) add(ProviderOption(ProviderEngines.OPENCODE, EngineCopy.OPENCODE_OWN, CredentialKind.OPENCODE,
                models(engine, ProviderEngines.OPENCODE), carried, EngineCopy.OPENCODE_OWN_DETAIL))
        }
        val runs = providers.filter { row ->
            val slug = row.text("slug") ?: return@filter false
            slug !in ProviderEngines.LOGIN_ENGINES && slug != ProviderEngines.OPENCODE && engine in providerEngines(slug)
        }
        fun option(row: JsonObject, kind: CredentialKind) = ProviderOption(row.text("slug")!!, row.text("label") ?: row.text("slug")!!, kind,
            models(engine, row.text("slug")!!), carried ?: row.text("unavailable"))
        return own + runs.filter(::isPool).map { option(it, CredentialKind.POOL) } + runs.filterNot(::isPool).map { option(it, CredentialKind.KEY) }
    }

    /** What an engine's own sign-in is called in the menu: the one account the runner reports by its own name, else Default — the
     * account dispatch resolves a session on the sign-in to. */
    private fun signInLabel(engine: String): String {
        val accounts = accounts(engine)
        return if (accounts.size == 1) RunnerPage.accountLabel(accounts.single().text("id").orEmpty(), accounts) else EngineCopy.DEFAULT
    }

    /**
     * The credential to show as current when [engine]'s menu does not list [provider]: a key this account no longer has on offer —
     * turned off, deleted — or not loaded yet, the legacy built-in `dsh` (DeepSeek Harness on a key in its workspace's environment),
     * a sign-in this runner does not report. Each renders what it is rather than silently reading as another credential, and never
     * changes the engine.
     */
    fun current(engine: String, provider: String): ProviderOption = credentials(engine).firstOrNull { it.id == provider } ?: when {
        provider == ProviderEngines.OPENCODE -> ProviderOption(provider, EngineCopy.OPENCODE_OWN, CredentialKind.OPENCODE, models(engine, provider),
            detail = EngineCopy.OPENCODE_OWN_DETAIL)
        provider in ProviderEngines.LOGIN_ENGINES -> ProviderOption(provider, EngineCopy.DEFAULT, CredentialKind.LOGIN, models(engine, provider))
        provider == ProviderEngines.DSH && row(provider) == null -> ProviderOption(provider, EngineCopy.WORKSPACE_KEY, CredentialKind.KEY,
            models(engine, provider), detail = "ORBIT_DSH_API_KEY")
        else -> (row(provider) ?: own?.firstOrNull { it.text("slug") == provider }).let { row ->
            ProviderOption(provider, row?.text("label") ?: provider, CredentialKind.KEY, models(engine, provider))
        }
    }

    /** What became of a session's own key when its engine's menu no longer lists it (board 5 ④): turned off — its page is where it
     * is turned back on — or deleted. Null for anything listed, a sign-in, OpenCode's own config, the legacy built-in `dsh`, and
     * while the account's own keys are unread. */
    fun gone(engine: String, provider: String): String? {
        if (provider in ProviderEngines.LOGIN_ENGINES || provider == ProviderEngines.OPENCODE) return null
        if (credentials(engine).any { it.id == provider } || row(provider) != null) return null
        val mine = own ?: return null
        val row = mine.firstOrNull { it.text("slug") == provider }
        if (row != null) return if (row.flag("enabled") == false) EngineCopy.TURNED_OFF else null
        return if (provider == ProviderEngines.DSH) null else EngineCopy.KEY_DELETED
    }

    /**
     * The New Session's engines, in ALL_ENGINES order (Claude Code, Codex, Kimi Code, Antigravity CLI, OpenCode, DeepSeek Harness),
     * each with its credentials and the one a pick of it lands on: the first of [preferred] it holds that can run (the draft's pick,
     * then what the workspace last ran), else its own sign-in, else the first credential that can run. An engine with nothing to run
     * on here is left out — except DeepSeek Harness on a runner that could run it: with no DeepSeek key yet it offers the connection.
     */
    fun engines(preferred: List<Pair<String?, String?>> = emptyList()): List<EngineOption> = ProviderEngines.ALL_ENGINES.mapNotNull { engine ->
        val options = credentials(engine)
        if (options.isEmpty()) {
            return@mapNotNull if (engine == ProviderEngines.DSH && dshBlocker() != "Update runner")
                EngineOption(engine, emptyList(), null, EngineCopy.CONNECT_DEEPSEEK_KEY) else null
        }
        val ready = options.filter { it.unavailable == null }
        val own = { option: ProviderOption -> option.kind == CredentialKind.LOGIN || option.kind == CredentialKind.OPENCODE }
        val landing = preferred.filter { it.first == engine }.firstNotNullOfOrNull { pick -> ready.firstOrNull { it.id == pick.second } }
            ?: ready.firstOrNull(own) ?: ready.firstOrNull() ?: options.firstOrNull(own) ?: options.first()
        EngineOption(engine, options, landing, landing.unavailable)
    }

    fun accounts(provider: String) = if (RunnerPage.keepsAccounts(provider))
        runner.objects("engines").firstOrNull { it.text("engine") == provider }?.objects("accounts").orEmpty() else emptyList()
    /** Whether a session here moves to another of the runner's [provider] accounts (EngineAccounts.moveCapability). */
    fun movesAccounts(provider: String) = EngineAccounts.moveCapability(provider) in runner.strings("capabilities")
    /** SessionProviderChoices.accountChoices: the runner's accounts of [provider] as rows, each with its own quota. */
    fun accountChoices(provider: String): List<AccountChoice> {
        val health = runner.objects("engines").firstOrNull { it.text("engine") == provider } ?: return emptyList()
        val accounts = accounts(provider)
        val usage = EngineAccounts.usage(provider, runner)
        return accounts.map { account ->
            val id = account.text("id").orEmpty()
            val label = RunnerPage.accountLabel(id, accounts)
            // Antigravity's Default on the runner's own Gemini key runs, on the key, with no quota of its own: not signed out.
            if (RunnerPage.runsOnEnvKey(health, id, account.text("auth"))) return@map AccountChoice(id, label, AccountCopy.ENV_KEY)
            val own = if (account.text("auth") == "yes") accountSnapshot(usage, id) else null
            val rows = own?.let(::usageRows).orEmpty()
            // The window closest to its limit; a bucket's row counts what is left, so its tightest is the binding one.
            val row = if (rows.any { it.remaining }) own?.let { bindingRow(it, System.currentTimeMillis()) } else rows.maxByOrNull { it.percent }
            AccountChoice(id, label, row?.let(::quotaText), (row?.utilization ?: 0.0) >= 90,
                if (account.text("auth") == "no") "Not signed in" else null)
        }
    }

    /**
     * The permission modes a session on [engine] can pick for [model] (web `permissionModeSupported` / `supportsAuto`): DeepSeek
     * Harness enforces Default, Auto and Don't Ask alone and the server refuses the rest at admission, so those are not offered;
     * elsewhere Bypass is gone on a root runner, and Auto on a Claude Code sign-in's model the runner says lacks it. A key or pool on
     * Claude Code owns its model space, which Claude's list cannot speak for.
     */
    fun permissions(engine: String, provider: String, model: String): List<String> {
        val modes = listOf("default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
        if (engine == ProviderEngines.DSH) return modes.filter { it in ProviderEngines.DSH_PERMISSION_MODES }
        val reported = models(engine, provider).firstOrNull { it.text("value") == model }
        return modes.filterNot { mode ->
            (runner.flag("runsAsRoot") == true && mode == "bypassPermissions") ||
                (mode == "auto" && engine == ProviderEngines.CLAUDE && row(provider) == null &&
                    if (reported?.get("permissionModes") is JsonArray) "auto" !in reported.strings("permissionModes")
                    else model !in setOf("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5"))
        }
    }

    /** The efforts [model] takes on [engine] with [provider]: its row's levels. A key's declared levels are Claude Code's to honour;
     * under OpenCode the same key's model is OpenCode's to describe, and says none here (contract §2.3). */
    fun efforts(engine: String, provider: String, model: String): List<String> {
        if (engine == ProviderEngines.OPENCODE && row(provider) != null) return emptyList()
        return models(engine, provider).firstOrNull { it.text("value") == model }?.strings("reasoningLevels").orEmpty()
    }

    /** Whether [model] has a fast lane on [engine] (@orbit/shared `fastModeAvailable`): Claude Code's where its row says so, Codex's
     * priority service tier; no other engine has one. */
    fun fast(engine: String, provider: String, model: String): Boolean {
        val row = models(engine, provider).firstOrNull { it.text("value") == model } ?: return false
        return when (engine) {
            ProviderEngines.CLAUDE -> row.flag("fastMode") == true
            ProviderEngines.CODEX -> row.flag("fastMode") == true || "priority" in row.strings("serviceTiers")
            else -> false
        }
    }
}

/** One account's tightest window, compactly: "5h 100%" — or, for an Antigravity bucket, which counts what is left, its bucket
 * and that: "gemini-5h 4% left". */
internal fun quotaText(row: UsageRow) =
    if (row.remaining) "${row.groupLabel ?: row.label} ${row.percent}% left" else ProviderPools.quotaReading(row)

/** What the re-send behind Retry runs on while this composer holds a pick for the session (RetryIdentityDto): the provider, its
 * engine and the account, and nothing else of what is held, which only a message sent carries. Empty without a provider: the
 * session's own. */
internal fun retryIdentity(config: JsonObject) =
    if (config.text("provider") == null) JsonObject(emptyMap()) else JsonObject(config.filterKeys { it in setOf("provider", "engine", "account") })

internal fun terminal(detail: JsonObject) = detail.text("status") in setOf("ENDED", "FAILED", "CANCELLED", "COMPLETED") ||
    detail.text("runStatus") in setOf("ENDED", "FAILED", "CANCELLED", "COMPLETED")

internal fun sendEndpoint(detail: JsonObject): String {
    val caps = detail["capabilities"] as? JsonObject
    if (caps != null) {
        if (caps.flag("canSend") == true) return "turns"
        if (caps.flag("canResume") == true) return "resume"
        error(caps.text("resumeBlockedReason") ?: "This session cannot receive messages.")
    }
    check(detail.text("lifecycleState") !in setOf("TRASHED", "COMPLETED")) { "Restore this session before sending." }
    check(detail.text("status") in setOf("PENDING", "RUNNING", "AWAITING_INPUT", "ENDED", "FAILED", "CANCELLED")) { "Session state is unavailable." }
    return if (terminal(detail)) "resume" else "turns"
}

internal fun SessionState?.canCompose() = this != null && fresh && !accessDenied && snapshot != null

/** The decision behind a task run whose model smart selection picked, while the composer still shows that model (OrbitKit
 * `ComposerLogic.smartRoute`; the session read's `route`): it marks the model chip ✦ and opens its menu on why. A model changed here
 * is this run's own, a session opened by hand has no route, a run on an Agent without smart selection has one that was not applied —
 * and so does every run while the account's switch (`preferences.modelRouting`, off by default) is off: all keep the chip as it was. */
internal fun smartRoute(taskId: String?, route: JsonObject?, model: String, smartSelection: Boolean): JsonObject? {
    if (!smartSelection || taskId.isNullOrEmpty() || route == null || route.flag("applied") != true) return null
    if (route.text("level").isNullOrEmpty() || route.text("model") != model) return null
    return route
}

/** A short paragraph's sentences, each with its full stop — what a phone's menu shows as items of their own (`ComposerLogic.sentences`). */
internal fun sentences(text: String): List<String> {
    val parts = text.split(". ")
    return parts.mapIndexed { index, part -> if (index < parts.size - 1) "$part." else part }
}

/** An effort as the chip's spoken name says it (OrbitKit `Effort.label`): "Default", "xHigh", else the word capitalised. */
internal fun effortLabel(effort: String?) = when {
    effort.isNullOrEmpty() -> "Default"
    effort == "xhigh" -> "xHigh"
    else -> effort.replaceFirstChar { it.uppercase() }
}

private val PARKED_STATES = setOf("AWAITING_INPUT", "INTERRUPTED", "SUCCEEDED", "ENDED", "CANCELLED")

/** The engine's guess at the next message, if the empty box offers it (docs/prompt-suggestions-design.md
 * §4.4; web `offeredPromptSuggestion`, OrbitKit `ComposerLogic.offeredPromptSuggestion`): nothing typed,
 * staged or pending, a conversation that can take a message, no turn in flight — the engine's own
 * included — no card waiting on the reader, and not after a run that failed. */
internal fun offeredPromptSuggestion(suggestion: String?, detail: JsonObject, draftEmpty: Boolean, usable: Boolean): String? {
    if (suggestion.isNullOrBlank() || !draftEmpty || !usable) return null
    val state = detail.text("runState") ?: detail.text("runStatus") ?: detail.text("status")
    if (state !in PARKED_STATES || detail.flag("engineTurnActive") == true) return null
    val waiting = (detail["pendingApprovals"] as? JsonPrimitive)?.intOrNull ?: 0
    if (waiting > 0 || detail.text("waitingKind") != null) return null
    if (detail.text("lifecycleState").let { it != null && it != "OPEN" }) return null
    val caps = detail["capabilities"] as? JsonObject
    if (caps != null && caps.flag("canSend") != true && caps.flag("canResume") != true) return null
    return suggestion
}

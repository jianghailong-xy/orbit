package io.orbitd.android.composer

import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.management.AccountCopy
import io.orbitd.android.management.EngineAccounts
import io.orbitd.android.management.ProviderPools
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

data class ProviderOption(val id: String, val label: String, val runtime: String,
    val models: List<JsonObject>, val unavailable: String? = null)

/** One of the runner's accounts of an engine as a row of the account menu (web AccountChoice): its own quota's tightest
 * window, compactly ("5h 12%", an Antigravity bucket by what is left: "gemini-5h 4% left"), "env key" for an Antigravity
 * Default on the runner's own Gemini key, and why it can't take a session. */
data class AccountChoice(val id: String, val label: String, val quota: String? = null, val nearLimit: Boolean = false,
    val unavailable: String? = null)

data class ComposerCatalog(val runner: JsonObject, val providers: List<JsonObject>) {
    fun usage(detail: JsonObject): JsonObject? {
        val provider = detail.text("provider") ?: return null
        if (provider == "opencode") return null
        // Antigravity's quota travels with its engine health, each Google account's its own; Default's too, which a Default
        // on the machine's Gemini key has none of.
        if (provider == "antigravity") {
            val account = detail.text("account") ?: detail.text("antigravityAccount") ?: EngineAccounts.DEFAULT
            if (account == EngineAccounts.AUTOMATIC) return null
            return accountSnapshot(EngineAccounts.usage(provider, runner), account)
        }
        if (provider !in BUILT_INS) {
            val row = providers.firstOrNull { it.text("slug") == provider } ?: return null
            if (row["members"] is JsonArray) {
                val assigned = detail.text("poolMemberProviderId")
                val member = if (assigned != null) row.objects("members").firstOrNull { ObjectId.same(it.text("id"), assigned) }
                    else row.objects("members").firstOrNull { it.flag("next") == true }
                return member?.get("planUsage") as? JsonObject
            }
            return row["planUsage"] as? JsonObject // Never borrow a runner login's quota for BYOK.
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
    fun slashItems(provider: String, agentId: String?): List<JsonObject> =
        (runner.objects("commands") + runner.objects("skills")).filter { item ->
            (item.text("agentId").isNullOrEmpty() || item.text("agentId") == agentId) && when (provider) {
                "codex", "opencode", "antigravity" -> false
                "kimi" -> item.text("provider") == "kimi"
                else -> item.text("provider") in listOf(null, "claude")
            }
        }.sortedWith(compareBy({ it.flag("builtin") == true }, { it.text("name")?.lowercase() }))
    fun runtime(provider: String): String? = if (provider in BUILT_INS || OpenCodeKeys.choiceKey(provider) != null) provider.substringBefore('/')
        else providers.firstOrNull { it.text("slug") == provider }?.text("runtime")
    fun models(provider: String): List<JsonObject> {
        // A key run on OpenCode offers the key's own models, under the OpenCode ids that name the key (OpenCodeKeys).
        OpenCodeKeys.choiceKey(provider)?.let { key ->
            return models(key).map { row -> JsonObject(row + ("value" to JsonPrimitive(OpenCodeKeys.model(key, row.text("value").orEmpty())))) }
        }
        val configured = providers.firstOrNull { it.text("slug") == provider }
        val own = configured?.objects("models").orEmpty()
        val space = runtime(provider) ?: return emptyList()
        // Configured third-party endpoints own their model space; modelsFromRuntime explicitly opts
        // vendor endpoints/pools into the runner's catalog, as in the existing provider contract.
        val live = (runner["modelCatalog"] as? JsonObject)?.get(space) as? JsonArray
        if (configured != null && (configured.flag("modelsFromRuntime") != true || live == null)) return own
        return live.orEmpty().filterIsInstance<JsonObject>()
    }
    fun options(current: String, newSession: Boolean = false): List<ProviderOption> {
        val runtime = runtime(current) ?: return emptyList()
        val engines = if (newSession) runner.objects("engines").mapNotNull { it.text("engine") } else listOf(runtime)
        return (engines + providers.mapNotNull { it.text("slug") }).distinct().filter { newSession || runtime(it) == runtime }.map { slug ->
            val row = providers.firstOrNull { it.text("slug") == slug }
            val space = runtime(slug) ?: runtime
            val engine = runner.objects("engines").firstOrNull { it.text("engine") == space }
            val blocker = if (engine?.flag("installed") == false) "Not installed" else null
            ProviderOption(slug, row?.text("label") ?: slug, space, models(slug), blocker
                ?: row?.text("unavailable") ?: if (row == null && engine?.text("auth") == "no" && engine.objects("accounts").none { it.text("auth") == "yes" }) "Not signed in" else null)
        }
    }
    private fun health(engine: String) = runner.objects("engines").firstOrNull { it.text("engine") == engine }
    private fun option(slug: String, unavailable: String?) =
        ProviderOption(slug, ProviderChoices.providerName(slug, providers), runtime(slug) ?: slug, models(slug), unavailable)
    /** SessionProviderChoices.choices: the runner's engines in iOS's order — claude, codex, antigravity, kimi — then the account
     * pools, then the configured keys, then OpenCode once the runner has it and the keys it may spend (A07-6: each key the server
     * marks `runsOnOpenCode`, listed again under OpenCode as `opencode/<slug>`). A row this runner can't run stays listed with why. */
    fun choices(): List<ProviderOption> {
        val engines = ProviderChoices.engineSlugs.map { slug -> option(slug, ProviderChoices.engineBlocker(health(slug))) }
        // A pool, like a configured key, needs the CLI it runs on and nothing signed in; what the server says it lacks follows.
        val pools = providers.filter { it.flag("pool") == true }.map { row ->
            val slug = row.text("slug").orEmpty()
            option(slug, ProviderChoices.byokBlocker(health(runtime(slug) ?: "claude")) ?: row.text("unavailable"))
        }
        // A configured row shadowing a built-in slug would dispatch the same identity as the engine above.
        val keys = providers.filter { it.flag("pool") != true && it.text("slug") !in ProviderChoices.engineSlugs + "opencode" }.map { row ->
            val slug = row.text("slug").orEmpty()
            option(slug, ProviderChoices.byokBlocker(health(ProviderChoices.executingRuntime(slug, providers))))
        }
        val openCode = if (health("opencode")?.flag("installed") != true) emptyList() else listOf(option("opencode", null)) +
            providers.filter { it.flag("runsOnOpenCode") == true && it.flag("pool") != true }.map { row ->
                val choice = OpenCodeKeys.choice(row.text("slug").orEmpty())
                ProviderOption(choice, row.text("label") ?: choice, "opencode", models(choice), null)
            }
        return engines + pools + keys + openCode
    }
    /** SessionProviderChoices.sameRuntime: what an existing session may move to — the choices on the CLI it was started on, in
     * the list's own order. A provider absent from them (removed, or OpenCode before the runner reports it) leads. */
    fun sameRuntime(current: String, choices: List<ProviderOption> = choices()): List<ProviderOption> {
        val runtime = ProviderChoices.executingRuntime(current, providers)
        val same = choices.filter { ProviderChoices.executingRuntime(it.id, providers) == runtime }
        return if (same.any { it.id == current }) same else listOf(option(current, null)) + same
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
    fun permissions(provider: String, model: String): List<String> {
        val runtime = runtime(provider)
        val reported = models(provider).firstOrNull { it.text("value") == model }
        val modes = listOf("default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
        return modes.filterNot { mode ->
            (runner.flag("runsAsRoot") == true && mode == "bypassPermissions") ||
                (mode == "auto" && provider == "claude" && runtime == "claude" &&
                    if (reported?.get("permissionModes") is JsonArray) "auto" !in reported.strings("permissionModes")
                    else model !in setOf("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5"))
        }
    }
    companion object { private val BUILT_INS = setOf("claude", "codex", "kimi", "opencode", "antigravity") }
}

/** One account's tightest window, compactly: "5h 100%" — or, for an Antigravity bucket, which counts what is left, its bucket
 * and that: "gemini-5h 4% left". */
internal fun quotaText(row: UsageRow) =
    if (row.remaining) "${row.groupLabel ?: row.label} ${row.percent}% left" else ProviderPools.quotaReading(row)

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

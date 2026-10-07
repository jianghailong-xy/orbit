package io.orbitd.android.composer

import io.orbitd.android.core.realtime.SessionState
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

data class ComposerCatalog(val runner: JsonObject, val providers: List<JsonObject>) {
    fun usage(detail: JsonObject): JsonObject? {
        val provider = detail.text("provider") ?: return null
        if (provider in setOf("opencode", "antigravity")) return null
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
    fun runtime(provider: String): String? = if (provider in BUILT_INS) provider
        else providers.firstOrNull { it.text("slug") == provider }?.text("runtime")
    fun models(provider: String): List<JsonObject> {
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
    fun accounts(provider: String) = if (provider in setOf("codex", "claude"))
        runner.objects("engines").firstOrNull { it.text("engine") == provider }?.objects("accounts").orEmpty() else emptyList()
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

package io.orbitd.android.management

import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import java.time.Instant

/** Management is owner-scoped by /runners and /workspaces, for USER and ADMIN alike. */
object WorkspaceRunnerPolicy {
    const val HEARTBEAT_MAX_AGE_MS = 90_000L
    private val accountPattern = Regex("default|[0-9a-f]{8}")
    val loginEngines = setOf("claude", "codex", "kimi", "antigravity")
    val accountEngines = setOf("claude", "codex")

    fun remoteRefusal(runner: JsonObject, now: Long = System.currentTimeMillis()): String? {
        if (!runner.flag("online") || runner.text("status") == "OFFLINE") return "Runner is offline. Reconnect the remote machine and refresh."
        val heartbeat = runCatching { Instant.parse(runner.text("lastHeartbeatAt")).toEpochMilli() }.getOrNull()
            ?: return "Runner heartbeat is unknown. Refresh before managing this machine."
        if (now - heartbeat > HEARTBEAT_MAX_AGE_MS || heartbeat - now > HEARTBEAT_MAX_AGE_MS)
            return "Runner heartbeat is stale. Refresh before managing this machine."
        if (runner.flag("heartbeatDraining")) return "Runner is draining. Wait until it is ready."
        return null
    }

    fun removalRefusal(runner: JsonObject, engine: String, account: String, now: Long = System.currentTimeMillis()): String? {
        if (engine !in accountEngines || !accountPattern.matches(account)) return "Unknown account."
        if (account == "default") return "Default is the machine's own login and cannot be removed."
        remoteRefusal(runner, now)?.let { return it }
        val capabilities = (runner["capabilities"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        if ("$engine-account-remove/v1" !in capabilities) return "Runner has not declared account removal support. Update the remote Runner first."
        return null
    }

    fun loginRefusal(runner: JsonObject, engine: String, now: Long = System.currentTimeMillis()): String? {
        remoteRefusal(runner, now)?.let { return it }
        if (engine !in loginEngines) return "This engine has no remote sign-in flow."
        if (runner.list("engines").firstOrNull { it.text("engine") == engine }?.flag("installed") != true)
            return "Install this engine on the remote Runner first."
        if (engine == "antigravity" && (runner["antigravity"] as? JsonObject)?.text("googleLogin") != "available")
            return "This Runner does not support Google sign-in. Check its platform and capabilities."
        return null
    }

    fun workspacePatch(original: JsonObject, name: String, instructions: String, workDir: String,
                       effort: String, enabled: Boolean, routing: Boolean): JsonObject {
        require(name.isNotBlank()) { "Workspace name is required." }
        return buildJsonObject {
            if (name.trim() != original.text("name")) put("name", name.trim())
            // Matches AgentFormContent: blank instructions/path mean leave the existing value alone.
            if (instructions.isNotEmpty() && instructions != original.text("appendSystemPrompt")) put("appendSystemPrompt", instructions)
            if (workDir.isNotEmpty() && workDir != original.text("workDir")) put("workDir", workDir)
            if (effort != original.text("effort")) put("effort", effort)
            if (enabled != (original["enabled"] != JsonPrimitive(false))) put("enabled", enabled)
            if (routing != original.flag("modelRouting")) put("modelRouting", routing)
        }
    }

    fun quota(runner: JsonObject, engine: String, account: String): JsonObject? =
        ComposerCatalog(runner, emptyList()).usage(buildJsonObject { put("provider", engine); put("account", account) })

    fun accountPatch(original: JsonObject, engine: String, selected: String?): JsonObject {
        require(engine in accountEngines)
        require(selected == null || accountPattern.matches(selected))
        return buildJsonObject {
            if (selected != original.text("${engine}Account").ifEmpty { null })
                put("${engine}Account", selected?.let(::JsonPrimitive) ?: JsonNull)
        }
    }
}

class RunnerUnavailable : IllegalStateException("This Runner is no longer on your account.")

/** Re-read ownership and heartbeat immediately before remote work; the server remains authoritative. */
class WorkspaceRunnerActions(private val api: ManagementApi) {
    suspend fun runner(id: String): JsonObject = (api.get("runners") as? JsonArray).orEmpty()
        .filterIsInstance<JsonObject>().firstOrNull { ObjectId.same(it.text("id"), id) }
        ?: throw RunnerUnavailable()

    suspend fun remote(id: String, operation: String, engine: String? = null) {
        require(operation in setOf("install", "engine-update", "refresh-models"))
        val latest = runner(id)
        check(WorkspaceRunnerPolicy.remoteRefusal(latest) == null) { WorkspaceRunnerPolicy.remoteRefusal(latest).orEmpty() }
        if (operation == "install") {
            require(engine in WorkspaceRunnerPolicy.loginEngines)
            check(engine != "antigravity" || (latest["antigravity"] as? JsonObject)?.flag("supported") == true) {
                "Runner has not declared Antigravity support."
            }
        }
        currentCoroutineContext().ensureActive()
        api.post("runners/$id/$operation", buildJsonObject { engine?.let { put("engine", it) } })
    }

    suspend fun startLogin(id: String, engine: String, account: String? = null, accountName: String? = null) {
        val latest = runner(id)
        check(WorkspaceRunnerPolicy.loginRefusal(latest, engine) == null) { WorkspaceRunnerPolicy.loginRefusal(latest, engine).orEmpty() }
        require(account == null || accountName == null)
        require((account == null && accountName == null) || engine in WorkspaceRunnerPolicy.accountEngines)
        require(account == null || Regex("default|[0-9a-f]{8}").matches(account))
        require(accountName == null || accountName.isNotBlank())
        currentCoroutineContext().ensureActive()
        api.post("runners/$id/login", buildJsonObject {
            put("engine", engine); account?.let { put("account", it) }; accountName?.let { put("accountName", it.trim()) }
        })
    }

    suspend fun removeAccount(id: String, engine: String, account: String) {
        val refusal = WorkspaceRunnerPolicy.removalRefusal(runner(id), engine, account)
        check(refusal == null) { refusal.orEmpty() }
        currentCoroutineContext().ensureActive()
        api.delete("runners/$id/accounts/$engine/$account")
    }

    suspend fun cleanUpWorkspace(id: String) {
        val workspace = api.get("workspaces/$id").jsonObject
        val runnerId = workspace.text("runnerId").ifEmpty { error("Workspace has no bound Runner.") }
        val refusal = WorkspaceRunnerPolicy.remoteRefusal(runner(runnerId))
        check(refusal == null) { refusal.orEmpty() }
        currentCoroutineContext().ensureActive()
        api.post("workspaces/$id/repo-cleanup")
    }
}

package io.orbitd.android.composer

import io.orbitd.android.management.ManagementApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

// The wire shapes of GitHub-backed workspaces (docs/github-workspace-design.md §5.2; shared `github.ts`; OrbitKit `Github.swift`): what
// the account's GitHub routes answer. Every field a newer server may leave out reads as absent rather than failing.

/** One installation of Orbit's GitHub App the person can reach. */
data class GithubInstallation(
    val id: Long,
    /** The GitHub account the App is installed on. */
    val account: String,
    /** `User` | `Organization`. */
    val type: String,
    /** `all` | `selected`. */
    val repositorySelection: String,
    val repositoryCount: Int,
) {
    companion object {
        fun fromJson(json: JsonObject) = GithubInstallation(
            id = json.long("id") ?: 0,
            account = json.text("account").orEmpty(),
            type = json.text("type").orEmpty(),
            repositorySelection = json.text("repositorySelection").orEmpty(),
            repositoryCount = json.long("repositoryCount")?.toInt() ?: 0,
        )
    }
}

/** One of [GithubIntegration.workspaces]: a workspace cloned from GitHub and the credential its clone used. */
data class GithubWorkspace(
    val id: String,
    val name: String,
    /** The machine it is on, by the name the person sees. */
    val machine: String? = null,
    /** `owner/name`. */
    val repository: String? = null,
    val cloneState: String? = null,
    /** `machine` (the machine's own Git credential) or `github-app` (Orbit's GitHub App); null until reported. */
    val credential: String? = null,
) {
    companion object {
        fun fromJson(json: JsonObject) = GithubWorkspace(
            id = json.text("id").orEmpty(),
            name = json.text("name").orEmpty(),
            machine = json.text("machine"),
            repository = json.text("repository"),
            cloneState = json.text("cloneState"),
            credential = json.text("credential"),
        )
    }
}

/** `GET /integrations/github` (and the answer of `DELETE`). */
data class GithubIntegration(
    /** An administrator set up the App and it is on. */
    val available: Boolean,
    val connected: Boolean,
    val login: String? = null,
    val connectedAt: String? = null,
    /** GitHub no longer takes the connection's tokens: Reconnect. */
    val needsReconnect: Boolean = false,
    /** Null when GitHub could not be asked. */
    val installations: List<GithubInstallation>? = emptyList(),
    val installUrl: String? = null,
    /** The account's workspaces cloned from GitHub. */
    val workspaceCount: Int = 0,
    /** Those workspaces, newest first. Absent from a server that predates it. */
    val workspaces: List<GithubWorkspace>? = null,
) {
    /** Connected, and GitHub still takes the connection: the repositories can be listed. */
    val usable: Boolean get() = connected && !needsReconnect

    /** How many repositories the App reaches for this person, over every installation; null when GitHub wasn't asked. */
    val repositoryCount: Int? get() = installations?.sumOf { it.repositoryCount }

    companion object {
        fun fromJson(json: JsonObject) = GithubIntegration(
            available = json.flag("available") == true,
            connected = json.flag("connected") == true,
            login = json.text("login"),
            connectedAt = json.text("connectedAt"),
            needsReconnect = json.flag("needsReconnect") == true,
            installations = (json["installations"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map(GithubInstallation::fromJson),
            installUrl = json.text("installUrl")?.takeIf { it.isNotEmpty() },
            workspaceCount = json.long("workspaceCount")?.toInt() ?: 0,
            workspaces = (json["workspaces"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map(GithubWorkspace::fromJson),
        )
    }
}

/** One of `GET /integrations/github/repos`. */
data class GithubRepository(
    val id: Long,
    val fullName: String,
    val private: Boolean,
    val defaultBranch: String,
    val installationId: Long = 0,
    val pushedAt: String? = null,
) {
    /** `orbit-labs/` — dimmed in the picker, before the name. */
    val owner: String get() = fullName.indexOf('/').let { if (it < 0) "" else fullName.substring(0, it + 1) }

    /** `orbit-web`. */
    val name: String get() = fullName.indexOf('/').let { if (it < 0) fullName else fullName.substring(it + 1) }

    companion object {
        fun fromJson(json: JsonObject) = GithubRepository(
            id = json.long("id") ?: 0,
            fullName = json.text("fullName").orEmpty(),
            private = json.flag("private") == true,
            defaultBranch = json.text("defaultBranch").orEmpty(),
            installationId = json.long("installationId") ?: 0,
            pushedAt = json.text("pushedAt"),
        )
    }
}

/** `GET /integrations/github/repos/:id/branches`. */
data class GithubBranches(val defaultBranch: String, val branches: List<String>) {
    companion object {
        fun fromJson(json: JsonObject) = GithubBranches(
            defaultBranch = json.text("defaultBranch").orEmpty(),
            branches = json.strings("branches"),
        )
    }
}

/** What the GitHub views ask the server; [ManagementGithub] is the app's, a test hands in its own. */
interface GithubSource {
    /** `GET /integrations/github`: whether the deployment has the App, and the account's connection. */
    suspend fun integration(): GithubIntegration
    /** `GET /integrations/github/repos?q=`: the repositories the person can pick, most recently pushed first. */
    suspend fun repositories(query: String): List<GithubRepository>
    /** `GET /integrations/github/repos/:id/branches`: asked only once Other branch is opened. */
    suspend fun branches(repoId: Long): GithubBranches
    /** `GET /integrations/github/start?return=`: where to send the person to sign in to GitHub. */
    suspend fun start(returnTo: String = GithubFlow.RETURN_PATH): String
    /** `DELETE /integrations/github`: forget the connection; answers the view as it now stands. */
    suspend fun disconnect(): GithubIntegration
    /** `POST /workspaces/:id/clone/retry`: a FAILED clone goes back to PENDING, and the runner is told. */
    suspend fun retryClone(workspaceId: String)
}

object GithubFlow {
    /** The Orbit page GitHub's sign-in comes back to: the web's Settings → GitHub, which says it connected. */
    const val RETURN_PATH = "/settings/integrations/github"
}

class ManagementGithub(private val api: ManagementApi) : GithubSource {
    override suspend fun integration() = GithubIntegration.fromJson(api.get("integrations/github").jsonObject)

    override suspend fun repositories(query: String): List<GithubRepository> {
        val page = api.get("integrations/github/repos", if (query.isEmpty()) emptyList() else listOf("q" to query)).jsonObject
        return page.objects("repositories").map(GithubRepository::fromJson)
    }

    override suspend fun branches(repoId: Long) =
        GithubBranches.fromJson(api.get("integrations/github/repos/$repoId/branches").jsonObject)

    override suspend fun start(returnTo: String): String {
        val url = api.get("integrations/github/start", listOf("return" to returnTo)).jsonObject.text("authorizationUrl")
        require(!url.isNullOrEmpty()) { "The server named no GitHub page to open" }
        return url
    }

    override suspend fun disconnect() = GithubIntegration.fromJson(api.delete("integrations/github").jsonObject)

    override suspend fun retryClone(workspaceId: String) {
        api.post("workspaces/$workspaceId/clone/retry")
    }
}

private fun JsonObject.long(key: String): Long? = (get(key) as? JsonPrimitive)?.takeUnless { it is JsonNull }?.let {
    it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong()
}

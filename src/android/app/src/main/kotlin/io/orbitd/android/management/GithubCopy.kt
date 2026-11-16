package io.orbitd.android.management

import io.orbitd.android.composer.GithubInstallation
import java.net.URLEncoder
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Settings → GitHub (docs/github-workspace-design.md §8, board 02): the account's GitHub connection, where Orbit's app is installed,
 * and the workspaces cloned from GitHub. The words are the web's `lib/githubIntegration.ts` and `pages/GithubIntegrationPage.tsx`, word
 * for word, under OrbitKit's `GithubCopy.swift` names; `GithubCopyParityTest` holds each one to both.
 */
object GithubCopy {
    const val TITLE = "GitHub"
    /** Settings' group the GitHub row is in, as the web's settings nav names it. */
    const val INTEGRATIONS = "Integrations"
    const val GITHUB_ROW_HINT = "Clone your repositories into workspaces, and land work back to them."
    const val GITHUB_NOT_SET_UP = "Not set up on this Orbit — ask an administrator."

    const val LOAD_FAILED = "Couldn't load your GitHub connection"
    const val RETRY = "Retry"
    const val ACCOUNT = "Your GitHub account"
    const val BADGE_SIGN_IN_AGAIN = "Sign in again"
    const val BADGE_CONNECTED = "Connected"
    fun needsSignInAgain(login: String): String = "@$login needs to sign in again"
    const val SEES_ONLY = "Orbit sees only the repositories you install its app on."
    /** "Connected Nov 3 · Orbit sees only …". */
    fun connectedSince(connectedAt: String?, nowMs: Long = System.currentTimeMillis()): String {
        val at = connectedAt?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() } ?: Instant.ofEpochMilli(nowMs)
        val day = DateTimeFormatter.ofPattern("MMM d", Locale.US).format(at.atZone(ZoneId.systemDefault()))
        return "Connected $day · $SEES_ONLY"
    }
    const val RECONNECT = "Reconnect"
    const val DISCONNECT = "Disconnect"
    const val DISCONNECT_TITLE = "Disconnect GitHub?"
    const val DISCONNECT_NO_WORKSPACES = "Orbit forgets your GitHub sign-in. You can connect again any time."
    /** "2 workspaces keep their folders. …" — said before Disconnect when any workspace came from GitHub. */
    fun disconnectWarning(workspaceCount: Int): String {
        val lead = if (workspaceCount == 1) "1 workspace keeps its folder." else "$workspaceCount workspaces keep their folders."
        return "$lead Clones and landings that need GitHub will stop until you connect again."
    }
    const val CONNECT_LEAD =
        "Connect GitHub to clone your repositories into workspaces. Orbit sees only the repositories you install its app on."
    const val CONNECT = "Connect"
    const val INSTALLED_WHERE = "Where Orbit’s app is installed"
    const val NO_ANSWER = "GitHub didn’t answer. Try again in a moment."
    const val CONFIGURE_ON_GITHUB = "Configure on GitHub"
    const val INSTALL_ON_GITHUB = "Install on GitHub"
    const val INSTALL_ON_ANOTHER = "Install on another account"
    const val WORKSPACES_FROM_GITHUB = "Workspaces from GitHub"
    fun onMachine(machine: String): String = "on $machine"

    const val CONNECTED_TOAST = "GitHub connected"
    const val DISCONNECTED_TOAST = "GitHub disconnected"
    const val DISCONNECT_FAILED = "Couldn't disconnect GitHub"
    const val CONNECT_FAILED = "Couldn't start connecting GitHub"

    /** Which credential a workspace from GitHub uses, as its clone reported it (board 02, note 3). */
    fun credentialText(credential: String?, cloneState: String?): String = when {
        credential == "github-app" -> "Uses Orbit’s GitHub app"
        credential == "machine" -> "Uses this machine’s Git credential"
        cloneState == "PENDING" || cloneState == "CLONING" -> "Cloning"
        cloneState == "FAILED" -> "The clone failed"
        else -> "Credential not reported"
    }

    /** What the callback's `github_error` means, said to the person who came back with it. */
    fun errorText(code: String): String = when (code) {
        "GITHUB_ACCOUNT_IN_USE" ->
            "That GitHub account is already connected to another Orbit account. Disconnect it there first, or sign in to GitHub as someone else."
        "GITHUB_DENIED" -> "GitHub sign-in was cancelled."
        "GITHUB_FLOW_EXPIRED" -> "The GitHub sign-in expired or was finished in another browser. Try again."
        "GITHUB_NOT_CONFIGURED" -> GITHUB_NOT_SET_UP
        else -> "GitHub didn't confirm the sign-in. Try again."
    }

    /** "Personal account · 3 selected repositories" or "Organization · All repositories (11)". */
    fun installationText(installation: GithubInstallation): String {
        val kind = if (installation.type == "Organization") "Organization" else "Personal account"
        val count = installation.repositoryCount
        val repositories = if (installation.repositorySelection == "all") "All repositories ($count)"
            else "$count ${if (count == 1) "selected repository" else "selected repositories"}"
        return "$kind · $repositories"
    }

    /** Where an installation's repositories are chosen, on GitHub. */
    fun installationSettingsUrl(installation: GithubInstallation): String =
        if (installation.type == "Organization") {
            val account = URLEncoder.encode(installation.account, "UTF-8").replace("+", "%20")
            "https://github.com/organizations/$account/settings/installations/${installation.id}"
        } else "https://github.com/settings/installations/${installation.id}"
}

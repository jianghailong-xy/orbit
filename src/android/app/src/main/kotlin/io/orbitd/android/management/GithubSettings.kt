package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.composer.GithubIntegration
import io.orbitd.android.composer.GithubSource
import io.orbitd.android.composer.githubWhy
import io.orbitd.android.composer.rememberResumes
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Settings → Integrations → GitHub (docs/github-workspace-design.md §8, board 02; web `GithubIntegrationPage.tsx`): the account's GitHub
 * connection, where Orbit's app is installed, and the workspaces cloned from GitHub. Which repositories the app reaches is managed on
 * GitHub; this page lists the installations and links there. Connect opens GitHub in the browser; the page reads the connection again
 * when the app comes back to the front.
 */
@Composable
internal fun GithubSettingsPage(github: GithubSource, revision: Long = 0L) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var view by remember(github) { mutableStateOf<GithubIntegration?>(null) }
    var error by remember(github) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var connecting by remember { mutableStateOf(false) }
    var disconnecting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    val resumes = rememberResumes()
    LaunchedEffect(github, revision, resumes, attempt) {
        val wasConnecting = connecting
        val before = view
        try {
            val next = github.integration()
            view = next
            error = null
            // Back from GitHub's sign-in, connected now: what the web's page says when the callback lands on it.
            if (wasConnecting && next.connected && !next.needsReconnect && before?.usable != true) {
                OrbitToasts.show(GithubCopy.CONNECTED_TOAST, tone = ToastTone.SUCCESS)
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            if (view == null) error = githubWhy(e)
        } finally {
            if (resumes > 0 || wasConnecting) connecting = false
        }
    }
    fun connect() {
        connecting = true
        scope.launch {
            try {
                uri.openUri(github.start())
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (e: Exception) {
                connecting = false
                OrbitToasts.show(GithubCopy.CONNECT_FAILED, detail = githubWhy(e), tone = ToastTone.ERROR)
            }
        }
    }
    fun disconnect() {
        disconnecting = true
        scope.launch {
            try {
                view = github.disconnect()
                OrbitToasts.show(GithubCopy.DISCONNECTED_TOAST, tone = ToastTone.SUCCESS)
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (e: Exception) {
                OrbitToasts.show(GithubCopy.DISCONNECT_FAILED, detail = githubWhy(e), tone = ToastTone.ERROR)
            } finally {
                disconnecting = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp).testTag("github-settings"),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        val current = view
        if (current == null) {
            val failed = error
            if (failed == null) Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else Notice(GithubCopy.LOAD_FAILED, failed, MaterialTheme.colorScheme.error) {
                Button(onClick = { error = null; attempt++ }, modifier = Modifier.testTag("github-retry")) { Text(GithubCopy.RETRY) }
            }
            return@Column
        }
        Text(GithubCopy.GITHUB_ROW_HINT, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!current.available) Notice(GithubCopy.GITHUB_NOT_SET_UP, null, Ink.amber)

        GithubCard(GithubCopy.ACCOUNT, badge = if (!current.connected) null else {
            if (current.needsReconnect) GithubCopy.BADGE_SIGN_IN_AGAIN to Ink.amber else GithubCopy.BADGE_CONNECTED to Ink.green
        }) {
            if (current.connected) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(
                        Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text((current.login ?: "?").take(1).uppercase(), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("@${current.login.orEmpty()}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (current.needsReconnect) GithubCopy.needsSignInAgain(current.login.orEmpty())
                            else GithubCopy.connectedSince(current.connectedAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (current.needsReconnect) Ink.amber else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (current.needsReconnect && current.available) {
                        Button(onClick = ::connect, enabled = !connecting, modifier = Modifier.testTag("github-reconnect")) {
                            Icon(painterResource(R.drawable.ic_github), null, Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(GithubCopy.RECONNECT)
                        }
                    }
                    OutlinedButton(
                        onClick = { confirming = true },
                        enabled = !disconnecting,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.testTag("github-disconnect"),
                    ) { Text(GithubCopy.DISCONNECT) }
                }
            } else {
                Text(GithubCopy.CONNECT_LEAD, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (current.available) {
                    Button(onClick = ::connect, enabled = !connecting, modifier = Modifier.padding(top = 10.dp).testTag("github-connect")) {
                        Icon(painterResource(R.drawable.ic_github), null, Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(GithubCopy.CONNECT)
                    }
                }
            }
        }

        if (current.usable) {
            GithubCard(GithubCopy.INSTALLED_WHERE) {
                val installations = current.installations
                if (installations == null) {
                    Text(GithubCopy.NO_ANSWER, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    installations.forEachIndexed { index, installation ->
                        if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        Row(Modifier.fillMaxWidth().testTag("github-installation"), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(installation.account, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text(GithubCopy.installationText(installation), style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            ExternalLink(GithubCopy.CONFIGURE_ON_GITHUB) { uri.openUri(GithubCopy.installationSettingsUrl(installation)) }
                        }
                    }
                    current.installUrl?.let { installUrl ->
                        if (installations.isNotEmpty()) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        ExternalLink(if (installations.isEmpty()) GithubCopy.INSTALL_ON_GITHUB else GithubCopy.INSTALL_ON_ANOTHER) {
                            uri.openUri(installUrl)
                        }
                    }
                }
            }
        }

        val workspaces = current.workspaces.orEmpty()
        if (workspaces.isNotEmpty()) {
            GithubCard(GithubCopy.WORKSPACES_FROM_GITHUB) {
                workspaces.forEachIndexed { index, workspace ->
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Column(Modifier.fillMaxWidth().testTag("github-workspace"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(workspace.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            workspace.machine?.let { Text(GithubCopy.onMachine(it), style = MaterialTheme.typography.bodyMedium) }
                        }
                        workspace.repository?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(GithubCopy.credentialText(workspace.credential, workspace.cloneState), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }

    val shown = view
    if (confirming && shown != null) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text(GithubCopy.DISCONNECT_TITLE) },
        text = {
            Text(if (shown.workspaceCount > 0) GithubCopy.disconnectWarning(shown.workspaceCount) else GithubCopy.DISCONNECT_NO_WORKSPACES)
        },
        confirmButton = {
            TextButton(onClick = { confirming = false; disconnect() }, modifier = Modifier.testTag("github-disconnect-confirm")) {
                Text(GithubCopy.DISCONNECT, color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
    )
}

@Composable
private fun GithubCard(title: String, badge: Pair<String, androidx.compose.ui.graphics.Color>? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                badge?.let { (words, tone) ->
                    Text(
                        words,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = tone,
                        modifier = Modifier.clip(CircleShape).background(tone.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 2.dp)
                            .testTag("github-badge"),
                    )
                }
            }
            content()
        }
    }
}

@Composable
private fun Notice(title: String, detail: String?, tone: androidx.compose.ui.graphics.Color, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(tone.copy(alpha = 0.12f)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.bodyMedium, color = tone, fontWeight = FontWeight.Medium)
        detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        action?.invoke()
    }
}

@Composable
private fun ExternalLink(text: String, open: () -> Unit) {
    Text(
        "$text ↗",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.clickable(role = Role.Button, onClick = open).padding(vertical = 6.dp, horizontal = 4.dp),
    )
}

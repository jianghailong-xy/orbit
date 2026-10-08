package io.orbitd.android.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import android.text.format.DateFormat
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.orbitd.android.BuildConfig
import io.orbitd.android.R
import java.util.Date

/** Settings → About: the installed version, a manual check, and the state of any update in progress. */
@Composable
fun AboutSection(updates: AppUpdater, modifier: Modifier = Modifier) {
    val state by updates.state.collectAsState()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
            style = MaterialTheme.typography.titleMedium)
        UpdateProgress(state)
        updateAction(updates, state)?.let { (label, action) -> Button(onClick = action) { Text(label) } }
        val idle = state !is UpdateState.Disabled && state !is UpdateState.Checking && state !is UpdateState.Downloading &&
            state !is UpdateState.Verifying && state !is UpdateState.Installing
        OutlinedButton(onClick = updates::checkNow, enabled = idle) { Text(stringResource(R.string.check_for_updates)) }
    }
}

/** Shows what an automatic check found, then follows that update through download and installation. */
@Composable
fun UpdatePromptHost(updates: AppUpdater, content: @Composable () -> Unit) {
    content()
    val context = LocalContext.current
    val confirmation by updates.confirmation.collectAsState()
    LaunchedEffect(confirmation) {
        val intent = confirmation ?: return@LaunchedEffect
        updates.confirmationShown()
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            updates.onInstallStatus(PackageInstaller.STATUS_FAILURE, null)
        }
    }
    val release = updates.prompt.collectAsState().value ?: return
    val state by updates.state.collectAsState()
    val action = updateAction(updates, state)
    val working = state is UpdateState.Downloading || state is UpdateState.Verifying || state is UpdateState.Installing
    AlertDialog(
        onDismissRequest = updates::dismissPrompt,
        title = { Text(stringResource(R.string.update_title)) },
        text = {
            Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.update_available, release.manifest.versionName, release.manifest.versionCode))
                if (state is UpdateState.Available) release.manifest.notes.trim().takeIf { it.isNotEmpty() }?.let {
                    Text(it.take(2000), style = MaterialTheme.typography.bodySmall)
                } else UpdateProgress(state)
            }
        },
        confirmButton = {
            action?.let { (label, run) ->
                TextButton(onClick = run) { Text(if (state is UpdateState.Available) stringResource(R.string.update_now) else label) }
            }
        },
        dismissButton = {
            TextButton(onClick = updates::dismissPrompt) {
                Text(stringResource(when {
                    state is UpdateState.Available -> R.string.update_later
                    working -> R.string.update_hide
                    else -> R.string.update_close
                }))
            }
        },
    )
}

@Composable
private fun UpdateProgress(state: UpdateState) {
    val context = LocalContext.current
    updateMessage(context, state)?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    if (state is UpdateState.Downloading) LinearProgressIndicator(
        progress = { (state.received.toFloat() / state.release.manifest.apkSize).coerceIn(0f, 1f) },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun updateAction(updates: AppUpdater, state: UpdateState): Pair<String, () -> Unit>? {
    val context = LocalContext.current
    return when (state) {
        is UpdateState.Available -> stringResource(R.string.update_install) to { updates.install(state.release) }
        is UpdateState.PermissionRequired -> stringResource(R.string.update_open_settings) to {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
        }
        is UpdateState.Failed -> state.release?.takeIf { state.reason != UpdateFailure.SIGNATURE }?.let { release ->
            stringResource(R.string.update_try_again) to { updates.install(release) }
        }
        else -> null
    }
}

private fun updateMessage(context: Context, state: UpdateState): String? = when (state) {
    UpdateState.Idle -> null
    UpdateState.Disabled -> context.getString(R.string.update_disabled)
    UpdateState.Checking -> context.getString(R.string.update_checking)
    UpdateState.Current -> context.getString(R.string.update_current)
    is UpdateState.Available -> context.getString(R.string.update_available, state.release.manifest.versionName, state.release.manifest.versionCode)
    is UpdateState.Downloading -> context.getString(R.string.update_downloading,
        Formatter.formatShortFileSize(context, state.received), Formatter.formatShortFileSize(context, state.release.manifest.apkSize))
    is UpdateState.Verifying -> context.getString(R.string.update_verifying)
    is UpdateState.PermissionRequired -> context.getString(R.string.update_permission)
    is UpdateState.Installing -> context.getString(R.string.update_installing)
    is UpdateState.Failed -> when (state.reason) {
        UpdateFailure.OFFLINE -> context.getString(R.string.update_offline)
        UpdateFailure.RATE_LIMITED -> context.getString(R.string.update_rate_limited,
            DateFormat.getTimeFormat(context).format(Date(state.retryAt ?: System.currentTimeMillis())))
        UpdateFailure.CHECK_FAILED -> context.getString(R.string.update_check_failed)
        UpdateFailure.DOWNLOAD_FAILED -> context.getString(R.string.update_download_failed)
        UpdateFailure.CHECKSUM -> context.getString(R.string.update_checksum)
        UpdateFailure.SIGNATURE -> context.getString(R.string.update_signature)
        UpdateFailure.INSTALL_CANCELLED -> context.getString(R.string.update_cancelled)
        UpdateFailure.INSTALL_FAILED -> context.getString(R.string.update_install_failed)
    }
}

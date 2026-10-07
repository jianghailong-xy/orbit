package io.orbitd.android.push

import android.Manifest
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity

/** One foreground cue for an independently verified approval outside the focused session, and the
 * one-time Android 13+ notification permission request after sign-in. */
@Composable
fun PushNoticeHost(controller: PushController, content: @Composable () -> Unit) {
    val notice by controller.notice.collectAsState()
    val signedIn by controller.signedIn.collectAsState(false)
    val context = LocalContext.current
    // The once-per-installation mark is written only after the system request was shown and answered.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { controller.permissionPromptFinished() }
    LaunchedEffect(signedIn) {
        if (signedIn && controller.claimPermissionPrompt()) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    Box(Modifier.fillMaxSize()) {
        content()
        notice?.let { message ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                    .widthIn(max = 840.dp).padding(12.dp).testTag("notification-notice"),
                // Orbit's own tinted surface: its primary-colored actions keep their contrast in light and
                // dark (the theme defines no inverse colors for Material's default inverse snackbar).
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                // Large text gets the full width; the actions move below it.
                actionOnNewLine = LocalDensity.current.fontScale >= 1.5f,
                action = {
                    TextButton(onClick = {
                        message.link?.let { link ->
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        }
                        controller.dismissNotice()
                    }) { Text("Open") }
                },
                dismissAction = { TextButton(onClick = controller::dismissNotice) { Text("Dismiss") } },
            ) { Text(message.payload.body ?: "Needs your reply") }
        }
    }
}

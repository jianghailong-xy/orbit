package io.orbitd.android.push

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

/** The one-time Android 13+ notification permission request after sign-in. An approval that arrives in the foreground draws
 * nothing here: it is noticed once, at the top, from the Open snapshot, as anything that starts waiting on you is (the owner,
 * 2026-11-15, `docs/mocks/needs-you-capsule/12-once`; `NeedsYouToasts`). */
@Composable
fun PushNoticeHost(controller: PushController, content: @Composable () -> Unit) {
    val signedIn by controller.signedIn.collectAsState(false)
    // The once-per-installation mark is written only after the system request was shown and answered.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { controller.permissionPromptFinished() }
    LaunchedEffect(signedIn) {
        if (signedIn && controller.claimPermissionPrompt()) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    content()
}

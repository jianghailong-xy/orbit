package io.orbitd.android.push

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** A13 settings can embed this component; permission is requested only by an explicit user tap. */
@Composable
fun NotificationSettings(controller: PushController) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var revision by remember { mutableIntStateOf(0) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        revision++; controller.requestReconcile()
    }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) revision++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val allowed = remember(revision) { controller.notifications.allowed() }
    Column {
        Text("Notifications")
        Text(when {
            !controller.configured -> "Push is unavailable in this build. You can still check sessions and decisions in Orbit."
            !allowed -> "Notifications are off. Sessions and decisions remain available in Orbit."
            else -> "Notifications are on. Manage categories in Android settings."
        })
        if (Build.VERSION.SDK_INT >= 33 && !allowed) TextButton(onClick = {
            request.launch(Manifest.permission.POST_NOTIFICATIONS)
        }) { Text("Allow notifications") }
        TextButton(onClick = {
            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
        }) { Text("Notification settings") }
    }
}

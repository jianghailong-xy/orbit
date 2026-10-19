package io.orbitd.android.push

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity

/** One foreground cue for an independently verified approval outside the focused session. */
@Composable
fun PushNoticeHost(controller: PushController, content: @Composable () -> Unit) {
    val notice by controller.notice.collectAsState()
    val context = LocalContext.current
    Box(Modifier.fillMaxSize()) {
        content()
        notice?.let { message ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                    .widthIn(max = 840.dp).padding(12.dp).testTag("notification-notice"),
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

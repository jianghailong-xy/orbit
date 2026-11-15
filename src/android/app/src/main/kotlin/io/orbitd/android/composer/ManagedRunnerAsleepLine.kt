package io.orbitd.android.composer

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * Above a composer whose session or draft runs on [runnerId]: when that runner is the account's managed runner, asleep, the shared composer
 * line (MANAGED_RUNNER_COPY.asleep.composer). Sending stays open, since a message wakes it. Nothing for any other runner or state.
 */
@Composable
internal fun ManagedRunnerAsleepLine(runnerId: String?, status: ManagedRunner.Status? = LocalManagedRunnerStatus.current) {
    if (ManagedRunner.row(runnerId, status)?.asleep != true) return
    Text(ManagedRunner.Asleep.COMPOSER, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("managed-runner-asleep-line"),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

package io.orbitd.android.management

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.DshRuntime
import kotlinx.serialization.json.JsonObject

/**
 * DeepSeek Harness on a runner's engine page (iOS e789ce3dc `dshSection`). Harness signs nothing in here — every session runs on the
 * DeepSeek key it was started with — so what this machine decides is whether it can start Harness at all, and the one fix made here is
 * installing the pinned CLI: why it can't run here, Install DeepSeek Harness where an install fixes that, and the install relay's own
 * words. A runner ready for Harness has nothing to fix here.
 */
@Composable
internal fun DshInstallSection(runner: JsonObject, offline: Boolean, install: () -> Unit) {
    val state = DshRuntime.state(runner)
    val relay = runner.obj("install")
    val said = relay?.takeIf { it.str("engine") == DshRuntime.ENGINE }?.str("message")?.takeIf { it.isNotEmpty() }
    if (state.hint == null && said == null) return
    FormSection {
        state.hint?.let { Text(it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
        if (state.installable) TextButton(enabled = !offline && relay?.str("status") !in setOf("pending", "installing"), onClick = install) {
            Text("Install DeepSeek Harness")
        }
        said?.let { Text(it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
    }
}

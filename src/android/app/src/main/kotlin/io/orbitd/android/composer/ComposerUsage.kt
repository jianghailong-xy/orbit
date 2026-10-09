package io.orbitd.android.composer

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.management.usageRows
import kotlinx.serialization.json.*

@Composable
fun ComposerUsage(model: ComposerModel, state: ComposerState, detail: JsonObject, session: SessionState?) {
    var expanded by remember { mutableStateOf(false) }
    val events = session?.transcript?.events.orEmpty()
    fun reported(key: String) = events.asReversed().firstNotNullOfOrNull { event ->
        (event.fields[key] as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    }
    val tokens = reported("contextTokens") ?: 0
    val window = reported("contextWindow") ?: state.catalog?.models(OpenCodeKeys.choice(detail.text("provider").orEmpty(), detail.text("model")))
        ?.firstOrNull { it.text("value") == detail.text("model") }?.get("contextWindow")?.jsonPrimitive?.longOrNull?.takeIf { it > 0 }
    val contextLabel = if (window == null) "$tokens tokens" else "$tokens / $window tokens"
    TextButton(onClick = { expanded = true; model.loadCatalog() }, contentPadding = PaddingValues(0.dp)) {
        Text("Context: $contextLabel · Usage", style = MaterialTheme.typography.bodySmall)
    }
    if (expanded) AlertDialog(onDismissRequest = { expanded = false }, title = { Text("Context and plan usage") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            Text("Context: $contextLabel")
            if (window != null) LinearProgressIndicator(progress = { (tokens.toFloat() / window).coerceIn(0f, 1f) })
            Text("${detail.text("provider").orEmpty()} · ${detail.text("model").orEmpty()}")
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry usage") } }
            val usage = state.catalog?.usage(detail)
            if (usage == null && !state.catalogLoading) Text("No quota reported for this account.")
            usage?.let { snapshot ->
                snapshot.text("planType")?.let { Text(it) }
                snapshot.text("fetchedAt")?.let { Text("Updated $it", style = MaterialTheme.typography.bodySmall) }
                // An Antigravity account's buckets say what is left, as agy does; a Kimi Code account's windows are its own
                // /usage panel's three, the month among them.
                val provider = snapshot.text("provider")
                if (provider == "antigravity" || provider == "kimi") usageRows(snapshot).forEach { row ->
                    row.groupLabel?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Text("${row.label}: ${row.percent}%${if (row.remaining) " remaining" else ""}")
                    LinearProgressIndicator(progress = { row.percent / 100f })
                    row.window.text("resetsAt")?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                }
                val limits = snapshot.objects("rateLimits")
                val blocks = if (provider == "kimi") emptyList() else if (limits.isEmpty()) listOf(snapshot) else limits
                blocks.forEach { block ->
                    block.text("limitName")?.let { Text(it) }
                    listOf("fiveHour" to "5 hours", "sevenDay" to "7 days", "sevenDayOpus" to "Opus · 7 days", "sevenDaySonnet" to "Sonnet · 7 days", "primary" to "Primary", "secondary" to "Secondary").forEach { (key, label) ->
                        (block[key] as? JsonObject)?.let { row ->
                            val percent = (row["utilization"] as? JsonPrimitive)?.doubleOrNull
                            if (percent != null) {
                                Text("${row.text("label") ?: label}: ${percent.toInt()}%")
                                LinearProgressIndicator(progress = { (percent.toFloat() / 100).coerceIn(0f, 1f) })
                                row.text("resetsAt")?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                    (block["credits"] as? JsonObject)?.let { credit ->
                        Text(if (credit.flag("unlimited") == true) "Credits: unlimited" else "Credits: ${credit.text("balance") ?: "unreported"}")
                    }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("Close") } })
}

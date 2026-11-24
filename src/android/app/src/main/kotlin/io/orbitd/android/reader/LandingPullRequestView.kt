package io.orbitd.android.reader

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/** What the pull request card needs from the app: a workspace's landing mode (the Faster tip hides on Push as me) and a way to open a
 * route (Landing settings, Open session). The default reads no mode and opens nothing, so a card drawn alone still draws. */
internal class LandingPullRequestEnv(val modeOf: (String) -> String?, val open: (OrbitRoute) -> Unit)

internal val LocalLandingPullRequest = staticCompositionLocalOf { LandingPullRequestEnv({ null }, {}) }

/** The workspace's own settings page, which the tip and the fallback card send the owner to (web `landingSettingsHref`). */
internal fun landingSettingsRoute(workspaceId: String?): OrbitRoute =
    if (workspaceId == null) OrbitRoute(Destination.SETTINGS, "workspace") else OrbitRoute(Destination.SETTINGS, "workspace", workspaceId, recordId = "landing")

private const val TIP_PREFS = "orbit.landing"
private const val TIP_KEY = "fasterTipHidden"

/**
 * The landing's pull request states (docs/mocks/protected-branch-landing 02, owner 2026-11-23), drawn from the `pullRequest` block a
 * landing read model carries; [LandingPullRequest.card] reads the block into the words. The dismissible Faster tip lives inside the
 * waiting-for-review card and is hidden once the card's workspace is on Push as me.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LandingPullRequestCard(pullRequest: JsonObject, main: String = "main", sessionId: String? = null, modifier: Modifier = Modifier) {
    val model = LandingPullRequest.card(pullRequest, main)
    val env = LocalLandingPullRequest.current
    val uri = LocalUriHandler.current
    val prefs = LocalContext.current.getSharedPreferences(TIP_PREFS, Context.MODE_PRIVATE)
    var hidden by remember { mutableStateOf(prefs.getBoolean(TIP_KEY, false)) }
    val workspaceId = pullRequest.text("workspaceId")?.takeIf { it.isNotEmpty() }
    val tip = LandingPullRequest.showsTip(model, workspaceId?.let(env.modeOf), hidden)
    val ink = when (model.tone) {
        PullRequestTone.BLUE -> MaterialTheme.colorScheme.primary
        PullRequestTone.GREEN -> LocalOrbitColors.current.success
        PullRequestTone.RED -> MaterialTheme.colorScheme.error
        PullRequestTone.AMBER -> LocalOrbitColors.current.needsYou
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.fillMaxWidth().background(ink.copy(alpha = 0.08f), RoundedCornerShape(14.dp)).padding(12.dp)
        .testTag("pull-request:${model.stage.name}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(model.head, Modifier.weight(1f).testTag("pull-request:head"), fontWeight = FontWeight.SemiBold, color = ink)
            model.right?.let { Text(it, Modifier.testTag("pull-request:right"), style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1, softWrap = false) }
        }
        if (model.segments.isNotEmpty()) Row(Modifier.fillMaxWidth().testTag("pull-request:bar"), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            model.segments.forEach { seg ->
                Box(Modifier.weight(1f).height(4.dp).background(when (seg) {
                    PullRequestSegment.PASSED -> LocalOrbitColors.current.success
                    PullRequestSegment.FAILED -> MaterialTheme.colorScheme.error
                    PullRequestSegment.PENDING -> muted.copy(alpha = 0.3f)
                }, RoundedCornerShape(2.dp)))
            }
        }
        Text(model.detail, Modifier.testTag("pull-request:detail"), style = MaterialTheme.typography.bodyMedium, color = muted)
        val actions = model.actions
        if (actions.isNotEmpty() || (model.stage == PullRequestStage.CHECK_FAILED && sessionId != null)) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (model.stage == PullRequestStage.CHECK_FAILED && sessionId != null) TextButton(onClick = { env.open(OrbitRoute(Destination.SESSION, sessionId)) },
                modifier = Modifier.testTag("pull-request:open-session")) { Text(PullRequestWords.OPEN_SESSION, fontWeight = FontWeight.SemiBold) }
            actions.forEach { action ->
                TextButton(onClick = { action.href?.let(uri::openUri) ?: env.open(landingSettingsRoute(workspaceId)) },
                    modifier = Modifier.testTag("pull-request:action:${action.label}")) { Text(action.label, fontWeight = FontWeight.SemiBold) }
            }
        }
        if (tip) Row(Modifier.fillMaxWidth().testTag("pull-request:tip"), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(PullRequestWords.TIP, style = MaterialTheme.typography.labelMedium, color = muted)
                Text(PullRequestWords.TIP_LINK, Modifier.clickable(role = Role.Button) { env.open(landingSettingsRoute(workspaceId)) }.padding(vertical = 6.dp)
                    .testTag("pull-request:tip-link"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = { prefs.edit().putBoolean(TIP_KEY, true).apply(); hidden = true }, modifier = Modifier.size(32.dp).semantics { contentDescription = PullRequestWords.DISMISS }.testTag("pull-request:tip-dismiss")) {
                Text("×", color = muted)
            }
        }
    }
}

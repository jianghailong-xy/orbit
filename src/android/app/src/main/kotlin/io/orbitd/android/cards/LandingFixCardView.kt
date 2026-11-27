package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.LandingFix
import io.orbitd.android.reader.LandingSessionModel
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/**
 * A failed landing handed to this task's own session (contract revision 42, §12.5 W6; board docs/mocks/landing-fix-own-session ② b,
 * ruled 2026-11-22): `From Orbit · Landing` with what failed on its chip, what Orbit could not land and where, the files that conflicted
 * (or the lines the check printed), the turn's three steps, and its last paragraph with the way into the landing. Under it, once this
 * session's fix has been queued to land again, the line that says so (② b ③), read from the landing's own record.
 */
@Composable
internal fun LandingFixCardView(card: InteractionCard, event: RunEvent?, open: (String) -> Unit) {
    val turn = remember(card.key) { LandingFixTurns.parse(card.source.text("text")) } ?: return
    val key = card.key
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val link = MaterialTheme.colorScheme.primary
    val shape = RoundedCornerShape(12.dp)
    val landing = turn.landingSessionId
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.conversationCard().testTag(key).background(tone.copy(alpha = 0.08f), shape).border(1.dp, tone.copy(alpha = 0.3f), shape)
            .padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(14.dp), tint = tone)
                Text(LandingFixCopy.FROM_ORBIT_LANDING.uppercase(), Modifier.weight(1f).testTag("$key:head"),
                    style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = tone, maxLines = 1)
                Text(if (turn.state == "CONFLICT") LandingFixCopy.CONFLICT else LandingFixCopy.CHECK_FAILED, Modifier.testTag("$key:kind")
                    .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(50)).border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(50))
                    .padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1)
            }
            Text(LandingFixCopy.couldNotLand(turn.target), Modifier.testTag("$key:title"), style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold)
            val code = SpanStyle(fontFamily = FontFamily.Monospace, background = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f))
            Text(buildAnnotatedString {
                append(LandingFixTurns.sentence(turn))
                turn.targetSha?.let { append(" at "); withStyle(code) { append(" $it ") } }
                append(". ")
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(LandingFixCopy.NOTHING_WAS_PUSHED) }
            }, Modifier.testTag("$key:sentence"), style = MaterialTheme.typography.bodyMedium)
            if (turn.quoted.isNotEmpty()) SelectionContainer {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp)
                    .testTag("$key:quoted"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    turn.quoted.forEach { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)) }
                }
            }
            Column(Modifier.testTag("$key:steps"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                turn.steps.forEachIndexed { index, step ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("${index + 1}.", style = MaterialTheme.typography.bodyMedium)
                        Text(LandingFixTurns.step(turn, step), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            HorizontalDivider(color = tone.copy(alpha = 0.25f))
            Text(buildAnnotatedString {
                append(LandingFixCopy.footer(turn.targetWords))
                if (landing != null) { append(" · "); withStyle(SpanStyle(color = link, fontWeight = FontWeight.SemiBold)) { append("${LandingFixCopy.OPEN_LANDING} ›") } }
            }, Modifier.testTag("$key:foot").then(if (landing != null) Modifier.clickable(role = Role.Button) { open("orbit-session:$landing") } else Modifier),
                style = MaterialTheme.typography.bodySmall, color = secondary)
        }
        landing?.let { LandingAgainLine(it, event, key, open) }
    }
}

/**
 * `↻ Landing 4be19c2 again · Open landing ›` (board ② b ③): this session's fix, landing again — the first fix this session made after the
 * card's turn, as the landing's record says it (`FIXED_BY_SESSION`). Nothing until there is one.
 */
@Composable
private fun LandingAgainLine(landingId: String, event: RunEvent?, key: String, open: (String) -> Unit) {
    val resources = LocalReaderResources.current
    val app = LocalContext.current.applicationContext as? OrbitApplication
    val live = app?.realtime?.state?.collectAsState()?.value
    val authorized = resources != null && live?.handle === resources.handle && live?.session?.id == resources.sessionId
    var detail by remember(landingId) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(resources, landingId, authorized, live?.session?.snapshotReads) {
        if (!authorized) return@LaunchedEffect
        try { detail = CardAuthority(resources!!.auth, resources.handle).get(listOf("sessions", landingId)) as? JsonObject }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { }
    }
    val sha = LandingFix.fixLandingAgain(LandingSessionModel.view(detail), resources?.sessionId, event?.ts) ?: return
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(Modifier.background(muted.copy(alpha = 0.1f), CircleShape).clickable(role = Role.Button) { open("orbit-session:$landingId") }
            .padding(horizontal = 12.dp, vertical = 6.dp).testTag("$key:again"), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_refresh), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
            Text(buildAnnotatedString {
                append(LandingFixCopy.landingAgain(sha).substringBefore(sha))
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface)) { append(sha) }
                append(LandingFixCopy.landingAgain(sha).substringAfter(sha))
            }, style = MaterialTheme.typography.bodySmall, color = muted)
            Text("${LandingFixCopy.OPEN_LANDING} ›", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary)
        }
    }
}

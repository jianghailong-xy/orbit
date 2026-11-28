package io.orbitd.android.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.ModeCapsule
import io.orbitd.android.core.cards.ModeLine
import io.orbitd.android.core.cards.PermissionModeDisplay
import io.orbitd.android.core.protocol.PermissionModeChange
import io.orbitd.android.core.protocol.PermissionModes
import io.orbitd.android.core.protocol.SessionFacts
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/*
 * The mode a session runs in, as the composer and the transcript draw it (board docs/mocks/permission-mode-actual, the owner's picks
 * A1, B1 and C1; iOS `SessionModeDisplay`): the words are PermissionModeDisplay's, the facts the session detail's and the runner
 * catalogue's. Nothing here guesses a mode: what runs is what the server recorded.
 */

/** The clock Claude's report is read against: it reads as being switched back for a minute (PermissionModeDisplay.CORRECTION_WINDOW).
 * A test of a payload captured from a server holds it at the payload's own moment, so the payload is drawn as the server sent it. */
internal var modeClock: () -> Instant = Instant::now

/** Whether the session's next run is still to start — a draft, one no claim has taken yet, or one whose run has ended, which the next
 * message resumes: then the control says what that run starts in, not what the last one ran in. */
internal fun runStartsNext(detail: JsonObject, draft: Boolean): Boolean = draft || SessionFacts.released(detail) == true || terminal(detail) ||
    PermissionModes.actual(detail) == null && (SessionFacts.phase(detail) == "PENDING" || detail.text("status") == "PENDING")

/** [model]'s name, when it is a Claude Code model with no Auto on the runner [catalog] reads (C1). */
internal fun noAutoModel(catalog: ComposerCatalog?, engine: String, provider: String, model: String): String? =
    catalog?.takeIf { it.autoMissing(engine, provider, model) }?.modelLabel(engine, provider, model)

/** A scheduled run on Claude Code runs in Auto, whatever its session asks (schedule-access.ts). */
internal fun scheduledOnClaude(detail: JsonObject, engine: String) = engine == ProviderEngines.CLAUDE && detail.text("scheduleRunId") != null

/** The composer's mode control for the session [detail] reads, under the box's picks [effective] — a draft's, or the ones held for an
 * ended session's resume — on [engine]. [events] are the conversation's loaded events, where a correction Claude refused is said. */
internal fun modeCapsule(detail: JsonObject, effective: JsonObject, engine: String, catalog: ComposerCatalog?, draft: Boolean,
    now: Instant, events: List<RunEvent> = emptyList()): ModeCapsule = PermissionModeDisplay.capsule(
    intent = shownPermissionMode(effective, engine),
    actual = PermissionModes.actual(detail),
    reported = PermissionModes.reported(detail),
    beforeStart = runStartsNext(detail, draft),
    latest = PermissionModes.changes(detail).lastOrNull(),
    noAutoModel = noAutoModel(catalog, engine, effective.text("provider") ?: engine, effective.text("model").orEmpty()),
    runsAsRoot = catalog?.runner?.flag("runsAsRoot") == true,
    scheduledOnClaude = scheduledOnClaude(detail, engine),
    now = now,
    refusal = PermissionModes.refusals(events).lastOrNull(),
)

/** The transcript's mode lines for [changes] of the session [detail] (B1) — its own newest and the older ones read as the transcript
 * pages back — judged against the intent the server holds: a pick held on this device for a resume is not one the engine was asked for.
 * [events], the conversation's loaded events, say each correction Claude refused. */
internal fun modeLines(detail: JsonObject?, changes: List<PermissionModeChange>, catalog: ComposerCatalog?,
    events: List<RunEvent> = emptyList()): List<ModeLine> {
    if (detail == null || changes.isEmpty()) return emptyList()
    val engine = ProviderChoices.engine(detail, catalog?.providers.orEmpty())
    return PermissionModeDisplay.lines(changes, shownPermissionMode(detail, engine), PermissionModes.actual(detail),
        noAutoModel(catalog, engine, detail.text("provider") ?: engine, detail.text("model").orEmpty()),
        catalog?.runner?.flag("runsAsRoot") == true, scheduledOnClaude(detail, engine), PermissionModes.refusals(events))
}

/** What the mode menu opens on (A1, C1): why the control reads as it does — its lead in bold, amber where it names a gap — over a rule. */
@Composable
internal fun ModeMenuHead(capsule: ModeCapsule) {
    val head = capsule.head ?: return
    val lead = if (capsule.gap != null) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurface
    Text(buildAnnotatedString {
        withStyle(SpanStyle(color = lead, fontWeight = FontWeight.SemiBold)) { append(head.lead) }
        append(" ")
        append(head.text)
    }, Modifier.widthIn(max = 280.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag("composer-mode-head"),
        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    HorizontalDivider()
}

/** One mode change in the transcript (B1): a quiet line on the left, a shield before it, the mode in bold; amber while it is the line
 * of a gap that still stands. */
@Composable
internal fun PermissionModeLineView(line: ModeLine) {
    val ink = if (line.gap) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.testTag(line.key), verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_shield), null, Modifier.padding(top = 2.dp).size(16.dp), tint = ink)
        Text(buildAnnotatedString {
            append(line.before)
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(line.mode) }
            append(line.after)
        }, style = MaterialTheme.typography.bodyMedium, color = ink)
    }
}

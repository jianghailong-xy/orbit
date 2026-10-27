package io.orbitd.android.reader

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.directory.RecapCard
import io.orbitd.android.directory.RecapCardCopy

/**
 * The conversation's last row while it is at rest ([RecapCard]; iOS `RecapCardView`, the web's `SessionRecapCard`): the recap the
 * list row reads, here whole, with when it was written and a way to write it again now. Where it sits and when it steps aside is
 * the reader's business; this is the card (docs/mocks/session-recap-display/04-decided).
 *
 * A footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a filled card the composer's shape, sitting on the composer, read as
 * something floating over the conversation. So it is one paragraph in the muted colour, the head running into the recap, with
 * Refresh beside its first line — always shown, as a phone has no hover to show it on.
 */
@Composable
internal fun RecapCardView(card: RecapCard, refreshing: Boolean, onRefresh: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.bodyMedium
    // The first line sits on the 48dp refresh button's centre line, where the card's head line sat; the mark is sized in sp, so it
    // grows with the words it heads.
    val (lineTop, mark, markTop) = with(LocalDensity.current) {
        val line = style.lineHeight.toDp()
        val mark = 15.sp.toDp()
        Triple(((48.dp - line) / 2).coerceAtLeast(0.dp), mark, (line - mark) / 2)
    }
    Row(Modifier.fillMaxWidth().testTag("recap-card")) {
        // The Settings row's own mark: the switch that governs this line.
        Icon(painterResource(R.drawable.ic_recap), null, Modifier.padding(top = lineTop + markTop).size(mark), tint = muted)
        Spacer(Modifier.width(6.dp))
        SelectionContainer(Modifier.weight(1f).padding(top = lineTop)) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(RecapCardCopy.word) }
                card.whenWritten?.let { append(" · $it") }
                append("  ")
                append(card.text)
            }, Modifier.alpha(if (refreshing) 0.45f else 1f).testTag("recap-card-text"), style = style, color = muted)
        }
        IconButton(onClick = onRefresh, enabled = !refreshing, modifier = Modifier.testTag("recap-refresh")) {
            if (refreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else Icon(painterResource(R.drawable.ic_refresh), RecapCardCopy.refresh, Modifier.size(18.dp), tint = muted)
        }
    }
}

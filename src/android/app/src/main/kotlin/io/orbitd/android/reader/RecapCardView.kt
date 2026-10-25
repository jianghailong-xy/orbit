package io.orbitd.android.reader

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.directory.RecapCard
import io.orbitd.android.directory.RecapCardCopy

/**
 * The conversation's last row while it is at rest ([RecapCard]; iOS `RecapCardView`, the web's `SessionRecapCard`): the recap the
 * list row reads, here whole, with when it was written and a way to write it again now. Where it sits and when it steps aside is
 * the reader's business; this is the card (docs/mocks/session-recap-display/04-decided).
 */
@Composable
internal fun RecapCardView(card: RecapCard, refreshing: Boolean, onRefresh: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().testTag("recap-card")) {
        Column(Modifier.padding(start = 14.dp, end = 2.dp, bottom = 13.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // The Settings row's own mark: the switch that governs this card.
                Icon(painterResource(R.drawable.ic_recap), null, Modifier.size(15.dp), tint = muted)
                Spacer(Modifier.width(6.dp))
                Text(buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(RecapCardCopy.word) }
                    card.whenWritten?.let { append(" · $it") }
                }, Modifier.weight(1f).testTag("recap-card-head"), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1)
                IconButton(onClick = onRefresh, enabled = !refreshing, modifier = Modifier.testTag("recap-refresh")) {
                    if (refreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    else Icon(painterResource(R.drawable.ic_refresh), RecapCardCopy.refresh, Modifier.size(18.dp), tint = muted)
                }
            }
            SelectionContainer(Modifier.padding(end = 12.dp)) {
                Text(card.text, Modifier.alpha(if (refreshing) 0.45f else 1f).testTag("recap-card-text"),
                    style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

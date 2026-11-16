package io.orbitd.android.reader

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.directory.RecapCard
import io.orbitd.android.directory.RecapCardCopy
import kotlin.math.roundToInt

/** How far ×'s 48dp button hangs past the end of the line, so the glyph sits near the edge the lines above end at. */
private val HANG = 12.dp
/** What × takes of the last line, a gap before its glyph included: the words of the last line end this far from its end. */
private val ROOM = 24.dp

/**
 * The conversation's last row while it is at rest ([RecapCard]; iOS `RecapCardView`, the web's `SessionRecapCard`): the recap the
 * list row reads, here whole, with when it was written. Where it sits and when it steps aside is
 * the reader's business; this is the card (docs/mocks/session-recap-display/04-decided).
 *
 * A footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a filled card the composer's shape, sitting on the composer, read as
 * something floating over the conversation. So it is one paragraph in the muted colour, the head running into the recap. One ×
 * at the end of the last line (2026-11-02, 07-last-line B), always shown, as a phone has no hover to show it on, hides this recap
 * in this conversation on this device (2026-11-01, 06-hide; [onHide] remembers that). It was a ⋮ menu with Refresh too; the owner,
 * 2026-11-16: no menu, no refresh, just the ×. A last line with no room for × leaves it a line of its own.
 */
@Composable
internal fun RecapCardView(card: RecapCard, onHide: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.bodyMedium
    // The Settings row's own mark (the switch that governs this line), on the first line's middle; sized in sp, so it grows with
    // the words it heads.
    val (mark, markTop) = with(LocalDensity.current) { 15.sp.toDp().let { it to (style.lineHeight.toDp() - it) / 2 } }
    // Where the paragraph's lines fell, as it is measured: × goes by the last one.
    val lines = remember { arrayOfNulls<TextLayoutResult>(1) }
    Row(Modifier.fillMaxWidth().testTag("recap-card")) {
        Icon(painterResource(R.drawable.ic_recap), null, Modifier.padding(top = markTop).size(mark), tint = muted)
        Spacer(Modifier.width(6.dp))
        Layout({
            SelectionContainer {
                Text(buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(RecapCardCopy.word) }
                    card.whenWritten?.let { append(" · $it") }
                    append("  ")
                    append(card.text)
                }, Modifier.testTag("recap-card-text"), style = style, color = muted,
                    onTextLayout = { lines[0] = it })
            }
            IconButton(onClick = onHide, modifier = Modifier.testTag("recap-hide")) {
                Icon(painterResource(R.drawable.ic_close), RecapCardCopy.hide, Modifier.size(18.dp), tint = muted)
            }
        }, Modifier.weight(1f)) { (paragraph, hide), constraints ->
            val text = paragraph.measure(constraints.copy(minHeight = 0))
            val button = hide.measure(Constraints())
            val laid = checkNotNull(lines[0])
            val last = laid.lineCount - 1
            val top = laid.getLineTop(last)
            val bottom = laid.getLineBottom(last)
            val own = laid.getLineRight(last) + ROOM.toPx() > constraints.maxWidth
            // ×'s middle on the last line's, or on a line of its own under it; its touch target hangs past the card's top and bottom.
            val middle = if (own) bottom + (bottom - top) / 2 else (top + bottom) / 2
            layout(constraints.maxWidth, text.height + if (own) (bottom - top).roundToInt() else 0) {
                text.place(0, 0)
                button.place(constraints.maxWidth + HANG.roundToPx() - button.width, (middle - button.height / 2f).roundToInt())
            }
        }
    }
}

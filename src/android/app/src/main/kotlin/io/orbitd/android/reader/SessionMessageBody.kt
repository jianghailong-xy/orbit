package io.orbitd.android.reader

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.isSpecified
import io.orbitd.android.core.cards.SessionMessageClamp
import io.orbitd.android.text.MarkdownText

/**
 * Another session's words, in its bubble (hugging them, so nothing here fills the width): whole when short, and past [SessionMessageClamp.FROM] lines their first
 * [SessionMessageClamp.LINES], fading out, with "Show more" / "Show less" under them (web `SessionMessageCard`). The body is measured at its
 * full height inside the cut, so the toggle appears only where something is actually hidden. [revealed] — a record link landed in this
 * turn — opens it, as a find opens it on web.
 */
@Composable
internal fun SessionMessageBody(words: String, open: (String) -> Unit, revealed: Boolean = false) {
    var expanded by rememberSaveable(words) { mutableStateOf(false) }
    LaunchedEffect(revealed) { if (revealed) expanded = true }
    var fullPx by remember(words) { mutableIntStateOf(0) }
    val linePx = lineHeightPx(LocalTextStyle.current)
    val folds = SessionMessageClamp.folds(fullPx, linePx)
    val clamped = folds && !expanded
    val density = LocalDensity.current
    Column {
        Box(
            Modifier.testTag(if (clamped) "session-message:clamped" else "session-message:whole")
                .then(if (clamped) Modifier.heightIn(max = with(density) { SessionMessageClamp.foldedPx(linePx).toDp() }).clipToBounds().fadeOut() else Modifier),
        ) {
            MarkdownText(
                words,
                Modifier.wrapContentHeight(Alignment.Top, unbounded = true).onSizeChanged { fullPx = it.height },
                open = open,
            )
        }
        if (folds) TextButton(onClick = { expanded = !expanded }, Modifier.testTag("session-message:toggle")
            .semantics { contentDescription = SessionMessageClamp.toggle(expanded) }) {
            Text(SessionMessageClamp.toggle(expanded), style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun lineHeightPx(style: TextStyle): Float = with(LocalDensity.current) {
    when {
        style.lineHeight.isSpecified -> style.lineHeight.toPx()
        style.fontSize.isSpecified -> style.fontSize.toPx() * 1.4f
        else -> 0f
    }
}

/** The last stretch of a folded body fades to nothing, so the cut reads as "there is more", not as a broken line. */
private fun Modifier.fadeOut(): Modifier = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        drawRect(Brush.verticalGradient(0.55f to Color.Black, 1f to Color.Transparent), blendMode = BlendMode.DstIn)
    }

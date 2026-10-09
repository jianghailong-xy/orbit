package io.orbitd.android.cards

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** A 1 dp outline dashed 4 on 3, as iOS draws a turn still waiting in the queue (`StrokeStyle(lineWidth: 1, dash: [4, 3])`). */
internal fun Modifier.dashedBorder(color: Color, radius: Dp = 8.dp) = drawBehind {
    val stroke = 1.dp.toPx()
    drawRoundRect(color, cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
}

/** How far each steer has got, by its turn: the `delivery` the latest `user_delivery` said, read by the reader off its window
 * (iOS `SteerDelivery`). Empty outside a conversation. */
val LocalSteerDeliveries = compositionLocalOf<Map<String, String>> { emptyMap() }

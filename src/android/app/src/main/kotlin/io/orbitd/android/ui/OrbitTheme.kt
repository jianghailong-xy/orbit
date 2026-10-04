package io.orbitd.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

data class OrbitColors(val needsYou: Color, val running: Color, val success: Color, val drawer: Color)
val LocalOrbitColors = staticCompositionLocalOf { OrbitColors(Color(0xFF985900), Color(0xFF0067C0), Color(0xFF247344), Color(0xFFF2F3F5)) }

private val light = lightColorScheme(primary = Color(0xFF0066BE), onPrimary = Color.White,
    secondary = Color(0xFF3D5D7A), onSecondary = Color.White,
    secondaryContainer = Color(0xFFE4EFFC), onSecondaryContainer = Color(0xFF123451),
    surfaceTint = Color(0xFF0066BE),
    background = Color(0xFFFDFDFE), surface = Color(0xFFFDFDFE), onSurface = Color(0xFF1C1C1E),
    surfaceVariant = Color(0xFFF0F1F4), onSurfaceVariant = Color(0xFF555861), outline = Color(0xFF757881),
    error = Color(0xFFB3261E))
private val dark = darkColorScheme(primary = Color(0xFF8AC6FF), onPrimary = Color(0xFF00335F),
    secondary = Color(0xFFB1CBE3), onSecondary = Color(0xFF16334B),
    secondaryContainer = Color(0xFF203F5C), onSecondaryContainer = Color(0xFFD4E8FC),
    surfaceTint = Color(0xFF8AC6FF),
    background = Color(0xFF18191B), surface = Color(0xFF18191B), onSurface = Color(0xFFF1F1F4),
    surfaceVariant = Color(0xFF292B2F), onSurfaceVariant = Color(0xFFBFC2CA), outline = Color(0xFF93969E),
    error = Color(0xFFFFB4AB))

/** Semantic iOS Typography.swift ramp using scalable Android sp; no Dynamic Type cap. */
private val typography = Typography(
    headlineLarge = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold),
    headlineMedium = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontFamily = FontFamily.SansSerif),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 16.sp),
)

@Composable
fun OrbitTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val semantic = if (darkTheme) OrbitColors(Color(0xFFFFC66D), Color(0xFF8AC6FF), Color(0xFF83DDA0), Color(0xFF101113))
        else LocalOrbitColors.current
    CompositionLocalProvider(LocalOrbitColors provides semantic) {
        MaterialTheme(colorScheme = if (darkTheme) dark else light, typography = typography, content = content)
    }
}

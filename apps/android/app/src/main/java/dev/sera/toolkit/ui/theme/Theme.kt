package dev.sera.toolkit.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.sera.toolkit.data.ThemePreference

@Immutable
data class SeraPalette(
    val canvas: Color,
    val surface: Color,
    val sunken: Color,
    val line: Color,
    val lineStrong: Color,
    val ink: Color,
    val inkMuted: Color,
    val inkFaint: Color,
    val accent: Color,
    val accentHover: Color,
    val accentInk: Color,
    val accentWash: Color,
    val danger: Color,
    val dangerWash: Color,
    val success: Color,
    val warning: Color,
    val isDark: Boolean,
)

val LightSeraPalette = SeraPalette(
    canvas = Color(0xFFFBFBF9),
    surface = Color(0xFFFFFFFF),
    sunken = Color(0xFFF4F4F1),
    line = Color(0xFFE0E0DC),
    lineStrong = Color(0xFFC7C7C1),
    ink = Color(0xFF18181D),
    inkMuted = Color(0xFF52525C),
    inkFaint = Color(0xFF5D5D67),
    accent = Color(0xFF3B5BD4),
    accentHover = Color(0xFF2E4BC0),
    accentInk = Color(0xFFFFFFFF),
    accentWash = Color(0xFFEDF0FC),
    danger = Color(0xFFC8372D),
    dangerWash = Color(0xFFFCECEA),
    success = Color(0xFF288A56),
    warning = Color(0xFFB87814),
    isDark = false,
)

val DarkSeraPalette = SeraPalette(
    canvas = Color(0xFF0F0F12),
    surface = Color(0xFF17171B),
    sunken = Color(0xFF202026),
    line = Color(0xFF2E2E36),
    lineStrong = Color(0xFF484853),
    ink = Color(0xFFF2F2F5),
    inkMuted = Color(0xFFB5B5BF),
    inkFaint = Color(0xFF9A9AA6),
    accent = Color(0xFF7F98F5),
    accentHover = Color(0xFF98ADFA),
    accentInk = Color(0xFF0D1126),
    accentWash = Color(0xFF1E2542),
    danger = Color(0xFFEC6E63),
    dangerWash = Color(0xFF331B1B),
    success = Color(0xFF4EBE82),
    warning = Color(0xFFDDA53E),
    isDark = true,
)

val LocalSeraPalette = staticCompositionLocalOf { LightSeraPalette }

private val SeraTypography = Typography(
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
    ),
)

@Composable
fun SeraTheme(
    preference: ThemePreference = ThemePreference.SYSTEM,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val useDark = when (preference) {
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
        ThemePreference.SYSTEM -> systemDark
    }
    val palette = if (useDark) DarkSeraPalette else LightSeraPalette

    val colorScheme = if (useDark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentInk,
            primaryContainer = palette.accentWash,
            onPrimaryContainer = palette.accent,
            background = palette.canvas,
            onBackground = palette.ink,
            surface = palette.surface,
            onSurface = palette.ink,
            surfaceVariant = palette.sunken,
            onSurfaceVariant = palette.inkMuted,
            outline = palette.line,
            outlineVariant = palette.lineStrong,
            error = palette.danger,
            errorContainer = palette.dangerWash,
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentInk,
            primaryContainer = palette.accentWash,
            onPrimaryContainer = palette.accent,
            background = palette.canvas,
            onBackground = palette.ink,
            surface = palette.surface,
            onSurface = palette.ink,
            surfaceVariant = palette.sunken,
            onSurfaceVariant = palette.inkMuted,
            outline = palette.line,
            outlineVariant = palette.lineStrong,
            error = palette.danger,
            errorContainer = palette.dangerWash,
        )
    }

    CompositionLocalProvider(LocalSeraPalette provides palette) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = SeraTypography,
            content = content,
        )
    }
}

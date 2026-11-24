package dev.sera.node.ui.theme

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
import dev.sera.node.data.ThemePreference

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
    val successWash: Color,
    val warning: Color,
    val warningWash: Color,
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
    danger = Color(0xFFB82D24),
    dangerWash = Color(0xFFFCECEA),
    success = Color(0xFF1B6E42),
    successWash = Color(0xFFEAF7F0),
    warning = Color(0xFF8E5805),
    warningWash = Color(0xFFFCF4E3),
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
    successWash = Color(0xFF173124),
    warning = Color(0xFFDDA53E),
    warningWash = Color(0xFF342914),
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
        fontSize = 11.5.sp,
        lineHeight = 15.sp,
    ),
)

@Composable
fun isSeraDarkTheme(preference: ThemePreference): Boolean {
    val systemDark = isSystemInDarkTheme()
    return when (preference) {
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
        ThemePreference.SYSTEM -> systemDark
    }
}

@Composable
fun SeraNodeTheme(
    preference: ThemePreference = ThemePreference.SYSTEM,
    content: @Composable () -> Unit,
) {
    val useDark = isSeraDarkTheme(preference)
    val palette = if (useDark) DarkSeraPalette else LightSeraPalette

    val colorScheme = if (useDark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentInk,
            primaryContainer = palette.accentWash,
            onPrimaryContainer = palette.accentHover,
            inversePrimary = LightSeraPalette.accent,
            secondary = Color(0xFF9EA6BD),
            onSecondary = Color(0xFF141824),
            secondaryContainer = Color(0xFF252A3B),
            onSecondaryContainer = Color(0xFFDCE2F7),
            tertiary = palette.success,
            onTertiary = Color(0xFF0A2416),
            tertiaryContainer = palette.successWash,
            onTertiaryContainer = palette.success,
            background = palette.canvas,
            onBackground = palette.ink,
            surface = palette.surface,
            onSurface = palette.ink,
            surfaceVariant = palette.sunken,
            onSurfaceVariant = palette.inkMuted,
            surfaceTint = palette.accent,
            inverseSurface = Color(0xFFE8E8ED),
            inverseOnSurface = Color(0xFF18181D),
            error = palette.danger,
            onError = Color(0xFF330C09),
            errorContainer = palette.dangerWash,
            onErrorContainer = Color(0xFFFFDAD6),
            outline = palette.line,
            outlineVariant = palette.lineStrong,
            scrim = Color(0xFF000000),
            surfaceBright = Color(0xFF2B2B33),
            surfaceDim = Color(0xFF0D0D10),
            surfaceContainerLowest = Color(0xFF0A0A0D),
            surfaceContainerLow = Color(0xFF141418),
            surfaceContainer = Color(0xFF1A1A20),
            surfaceContainerHigh = Color(0xFF222229),
            surfaceContainerHighest = Color(0xFF2A2A33),
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentInk,
            primaryContainer = palette.accentWash,
            onPrimaryContainer = palette.accentHover,
            inversePrimary = DarkSeraPalette.accent,
            secondary = Color(0xFF4A5573),
            onSecondary = Color(0xFFFFFFFF),
            secondaryContainer = Color(0xFFE6EBF8),
            onSecondaryContainer = Color(0xFF1F2B4D),
            tertiary = palette.success,
            onTertiary = Color(0xFFFFFFFF),
            tertiaryContainer = palette.successWash,
            onTertiaryContainer = palette.success,
            background = palette.canvas,
            onBackground = palette.ink,
            surface = palette.surface,
            onSurface = palette.ink,
            surfaceVariant = palette.sunken,
            onSurfaceVariant = palette.inkMuted,
            surfaceTint = palette.accent,
            inverseSurface = Color(0xFF23232A),
            inverseOnSurface = Color(0xFFF2F2F5),
            error = palette.danger,
            onError = Color(0xFFFFFFFF),
            errorContainer = palette.dangerWash,
            onErrorContainer = palette.danger,
            outline = palette.line,
            outlineVariant = palette.lineStrong,
            scrim = Color(0xFF000000),
            surfaceBright = Color(0xFFFFFFFF),
            surfaceDim = Color(0xFFEAEAE5),
            surfaceContainerLowest = Color(0xFFFFFFFF),
            surfaceContainerLow = Color(0xFFF7F7F4),
            surfaceContainer = Color(0xFFF2F2EE),
            surfaceContainerHigh = Color(0xFFECECE7),
            surfaceContainerHighest = Color(0xFFE5E5E0),
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

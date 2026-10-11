package io.orbitd.android.management

import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject

val LocalAppearanceChanged = staticCompositionLocalOf<(String) -> Unit> { {} }
/** The account's smart model selection switch (`preferences.modelRouting`; off unless the owner turned it on, iOS
 * UserPreferences.smartModelSelection), read with the theme from the same `users/me`. While it is off no page draws smart selection:
 * the composer's ✦ (OrbitKit `ComposerLogic.smartRoute`), the task page's Suggested and tier tags, the workspace form's Task runs.
 * Settings' switch sets it the moment the server has taken the change. */
val LocalSmartSelection = compositionLocalOf { false }
val LocalSmartSelectionChanged = staticCompositionLocalOf<(Boolean) -> Unit> { {} }
/** The account's Session recaps switch (`preferences.recaps`; on unless the owner turned it off, iOS UserPreferences.showRecaps),
 * read with the theme from the same `users/me`. While it is off no session list draws the server's rolling recap: a row falls back
 * to the raw last reply it showed before the recap existed — on this page and on a project's. Settings' switch sets it the moment
 * the server has taken the change. */
val LocalSessionRecaps = compositionLocalOf { true }
val LocalSessionRecapsChanged = staticCompositionLocalOf<(Boolean) -> Unit> { {} }

// androidx.activity's own defaults for the navigation bar's scrim (EdgeToEdge.kt).
private val LightScrim = Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
private val DarkScrim = Color.argb(0x80, 0x1b, 0x1b, 0x1b)

/** The server owns the preferences. A new login cannot inherit the previous account's theme, or its smart model selection. */
@Composable
fun AccountAppearance(app: OrbitApplication, content: @Composable () -> Unit) {
    val auth by app.session.state.collectAsState()
    val handle = (auth as? AuthState.SignedIn)?.handle
    val live by remember(app) { app.realtime.state.map { it.handle to it.invalidationRevision }.distinctUntilChanged() }
        .collectAsState(null to 0L)
    val revision = if (live.first === handle) live.second else 0L
    var theme by remember(handle) { mutableStateOf("system") }
    var smartSelection by remember(handle) { mutableStateOf(false) }
    var sessionRecaps by remember(handle) { mutableStateOf(true) }
    var appearanceVersion by remember(handle) { mutableLongStateOf(0L) }
    var smartSelectionVersion by remember(handle) { mutableLongStateOf(0L) }
    var sessionRecapsVersion by remember(handle) { mutableLongStateOf(0L) }
    var resume by remember { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) resume++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(handle, resume, revision) {
        if (handle != null) {
            val version = appearanceVersion
            val smartVersion = smartSelectionVersion
            val recapsVersion = sessionRecapsVersion
            try {
                val user = ManagementApi(app.session, handle).get("users/me") as JsonObject
                if (version == appearanceVersion) theme = (user["preferences"] as? JsonObject)?.text("theme") ?: "system"
                // A read that left before the switch was pressed does not take its answer back.
                if (smartVersion == smartSelectionVersion) smartSelection = smartModelSelection(user["preferences"] as? JsonObject)
                if (recapsVersion == sessionRecapsVersion) sessionRecaps = sessionRecapsEnabled(user["preferences"] as? JsonObject)
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { /* Keep this account's last known preference until the next refresh. */ }
        }
    }
    val dark = when (theme) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    // enableEdgeToEdge() sized the bars' icons for the system's mode; the account's own appearance decides them,
    // or a dark app under a light system keeps dark icons on a dark bar. Same transparent bars and scrims as before.
    val activity = LocalActivity.current as? ComponentActivity
    DisposableEffect(activity, dark) {
        activity?.enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
            navigationBarStyle = SystemBarStyle.auto(LightScrim, DarkScrim) { dark })
        onDispose { }
    }
    CompositionLocalProvider(LocalAppearanceChanged provides { appearanceVersion++; theme = it }, LocalSmartSelection provides smartSelection,
        LocalSmartSelectionChanged provides { smartSelectionVersion++; smartSelection = it },
        LocalSessionRecaps provides sessionRecaps, LocalSessionRecapsChanged provides { sessionRecapsVersion++; sessionRecaps = it }) {
        OrbitTheme(darkTheme = dark, content = content)
    }
}
